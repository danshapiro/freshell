# Unified Terminal Session Identity Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision note:** This is the post-validation rewrite. All twenty load-bearing
> assumptions were validated (groups G1–G5). Six lifecycle assumptions were
> falsified, the cross-runtime admission race was confirmed as a deterministic
> production hole on the REST door, and the original task sequence was proven
> non-executable. This revision encodes every validator-required correction and
> five explicit user product decisions. Do not resurrect the previous revision's
> lifecycle semantics, residual-race language, or task ordering.

> **Revision 2 (Fresh Eyes round 1 + PR #584 reconciliation):** An independent
> Fresh Eyes review failed the previous revision with one critical and ten
> major findings (all encoded below — see the "Fresh Eyes Round 1" table), and
> PR #584 (`fix/rest-terminal-session-identity`, kata `hbsa`) plus PR #583
> merged into `origin/main` while that revision was being written. The base is
> now `6147c700`; the original `gf ui` incident is **fixed on main**; Slice E1
> landed verbatim; and the landed `PaneIdentityBinder` seam is absorbed, not
> avoided (see "Reconciliation with Merged PR #584"). This plan file was
> **renamed** to `2026-07-29-unified-terminal-identity-publication.md`; the old
> path `docs/superpowers/plans/2026-07-29-rest-terminal-session-identity.md`
> now holds PR #584's own historical plan document — never edit that file.

> **Revision 3 (Fresh Eyes round 2):** A second independent Fresh Eyes review
> failed revision 2 with 2 critical + 12 major + 1 minor findings — all
> encoded below (see the "Fresh Eyes Round 2" table). The structural changes:
> `SessionAdmission` bindings now carry a table-minted **admission epoch**
> token required by every cleanup call (FE-R2-1, closing the codex
> double-clear reuse race); a refused discovery collision installs a
> **conflict hold** that keeps the key closed until the refused-but-running
> process exits (FE-R2-2); `Held`/`BoundLive` expose the **holder kind** so
> each door maps same-kind vs cross-kind contention to its exact error
> (FE-R2-3); pending markers are deleted on **every** exit while `Closed`
> retirement stays explicit-close-only (FE-R2-7); explicit-close retirement is
> **awaitable** and awaited by `handle_kill` (FE-R2-8); the REST
> announcement/guard ordering is an explicit **two-phase settle handoff**
> (FE-R2-9); freshness pairing gets an atomic
> `peek_with_freshness` in `freshell-sessions` (FE-R2-5) and a defined
> fresh-`Unknown` disposition (FE-R2-6). The base also moved again:
> `origin/main` is now `c5e9fdaa` (PR #585, deck visual work only —
> `git diff 6147c700..c5e9fdaa -- crates docs/superpowers/plans` is empty, so
> every crate-level file:line fact verified on `6147c700` remains valid).

> **Revision 4 (Fresh Eyes round 3 + D3 clarification):** a third independent
> Fresh Eyes review failed revision 3 with 1 critical + 13 major findings —
> all encoded below (see the "Fresh Eyes Round 3" table). Two corrections of
> record: (a) revision 3's commit message overstated the REST
> announcement/guard ordering as "resolved" — the round-3 review proved that
> handoff **circular** as specified (the route awaited the settle
> `JoinHandle` for the spawn result while the settle task awaited the
> route's closure; FE-R3-8), and revision 4 replaces it with the
> **phase-one result channel** design; (b) the user clarified **D3** for the
> critical finding: a retroactively **discovered** collision is
> **accept + alarm** — refused atomically, conflict-held, loudly alarmed,
> process left running — and the headline invariant is restated honestly
> everywhere: two writers are never **admitted**; a late-discovered
> collision is refused, poisoned, and alarmed, with exposure bounded by
> user action (see "Admission invariant, stated honestly"). Structural
> changes: `claim_discovered` takes the caller's prior `BoundOwner` token
> (FE-R3-2); conflict holds carry their own minted hold epoch with deduped
> installs and epoch-conditional release (FE-R3-3); the discovery helper
> gains rollback, row-stored tokens/hold handles, and an atomic
> `rebind_discovered` for fork/signal switches (FE-R3-4/5); the live-owner
> check self-exempts the candidate's own row (FE-R3-6); `Poisoned` exposes
> holder kinds (FE-R3-7); duplicate terminal ids are rejected by
> **pre-reservation before PTY spawn** (FE-R3-9); the settle task re-checks
> the row before announcing (FE-R3-10); the sink keeps a publication-time
> ownership record for retirement (FE-R3-11); amplifier admission is claimed
> before `ensure_session` (FE-R3-12); provenance assertions are rescoped to
> typed seams — no persistence schema stores provenance (FE-R3-13); and the
> freshagent route tests observe only the injected fake sink, with ledger
> reloads moved to the ws integration target (FE-R3-14).

**Goal:** Give every authoritative terminal session identity—accepted resume,
server-preallocated fresh identity, provider-discovered identity, or
existence-validated legacy resume—one provider-aware publication pipeline that
atomically joins the terminal row to the shared identity registry, records the
pane ledger durably, retires it correctly by exit cause, and enqueues ordered
client invalidations; and make cross-kind (terminal vs fresh-agent) session
admission a single atomic claim so that **two writers are never admitted** —
no create, attach, or resume door can spawn or adopt a second writer for one
provider session file. For providers that reveal identity only after launch,
a late-**discovered** collision is refused, poisoned, and loudly alarmed,
with exposure bounded by user action (D3-clarified; see "Admission
invariant, stated honestly" — this plan never claims absolute two-writer
prevention for that case).

**Architecture:** Take over and generalize the existing
`PaneIdentitySink`/`LedgerIdentitySink` design, **absorbing** the
`PaneIdentityBinder` seam that PR #584 landed (trait in
`crates/freshell-terminal/src/registry.rs:655-703`, production
`LedgerPaneIdentityBinder` in `crates/freshell-ws/src/pane_identity_binder.rs`
\u2014 already the crate placement LB18 requires). The binder's four REST call
sites migrate onto the extended sink, its landed unit tests move with them,
and the binder trait + module are deleted once no call sites remain (Slice
E2; see "Reconciliation with Merged PR #584"). Provider policy produces
an identity candidate with explicit provenance; the shared sink authorizes it
(live-owner checks strictly before existence mapping), publishes the in-memory
identity through new atomic `TerminalRegistry` primitives, persists it
post-spawn with a typed durability result, and emits one ordered announcement.
The production sink implementation moves into `freshell-ws` (the server crate
is bin-only and cannot be imported by tests). A new shared
`SessionAdmission` table in `freshell-terminal` becomes the one atomic
admission point for terminal D8 leases and `FreshAgentSessionLeases`; the
existing reciprocal liveness probes become fast paths only. Claude still
preallocates `--session-id`, Amplifier still mints and pre-stubs before launch
(after a probe-only existence decision for legacy ids), and OpenCode still
launches without `--session` and binds only after its locator discovers the
provider-owned id.

**Persistence claim:** `TerminalIdentityDurability::Durable` means the awaited
post-spawn pane-ledger write completed and a newly constructed `PaneLedger`
over the same root reloads the binding after an ordinary server/process
restart. It does not promise survival of arbitrary power loss,
controller-cache failure, or filesystem corruption. The single pre-spawn
ledger write in the system is the established **PIN2 fresh-Claude minted-id
binding** (WS door `crates/freshell-ws/src/terminal.rs:2198`; REST door landed
in #584) \u2014 a bounded, exclusive-by-construction exception documented under
Lifecycle Corrections (LB5). No other pre-spawn ledger writes exist or may be
added.

**Tech Stack:** Rust 2021 (toolchain 1.96.0), Axum, Tokio,
`freshell-terminal`, `freshell-freshagent`, `freshell-ws`,
`freshell-server`, React 18, Redux Toolkit, Vitest, Testing Library, Playwright.

---

## Approvals Already Granted (do not reopen)

The user made these product decisions after reviewing the validator packet.
Implementers and reviewers must encode them, not relitigate them.

- **D1 (LB16) — Gemini/Kimi unchanged.** Keep the existing
  `mode + resume_session_id` directory synthesis in `/api/terminals` and the
  existing pane promotion **solely** for `gemini`/`kimi`, as a documented
  compatibility carve-out. The four-provider existence model, the classifier,
  and the `/api/terminals` projection change are scoped to
  claude/codex/opencode/amplifier only. Kata `jb4z` tracks eventual
  deprecation of Gemini/Kimi session restore.
- **D2 (LB14) — Loser gets a structured refusal, not a redirect.** The
  cross-kind admission loser receives a deterministic structured error: REST
  `409 RESTORE_UNAVAILABLE`, WS `error{RESTORE_UNAVAILABLE}` frame,
  fresh-agent `create.failed{SESSION_RESERVED, retryable: true}`. No
  redirect-to-existing-pane feature in this branch.
- **D3 (LB14, clarified after Fresh Eyes round 3) — Retroactively
  discovered collision: ACCEPT + ALARM.** When a fresh Codex/OpenCode
  terminal discovers a session id another writer already owns (same kind or
  cross kind), refuse the binding atomically, install the epoch-carrying
  conflict hold (no third writer, no reopen), leave the running process
  alone, and raise a loud user-visible alarm plus an invariant-level log
  (the concrete surfaces are specified in "Admission invariant, stated
  honestly"). By the time discovery fires, both processes are already
  attached to the session file — the guarantee for this case is honest
  refusal + containment + alarm, never undoing; exposure is bounded by user
  action. Freezing or killing the newcomer is explicitly out of scope.
- **D4 (LB14) — The REST-door two-writer hole is fixed early in this
  branch.** The `SessionAdmission` extraction and REST-door protection are
  sequenced as Slice B0, before every publication slice, so the deterministic
  corruption hole on current `origin/main` closes first. No separate hotfix
  PR. **Updated factual basis after #584 (decision unchanged):** the landed
  A13 pins (`crates/freshell-ws/tests/rest_claude_identity.rs`, "A13 refusal
  of REST-live sessions") close only the *reverse* direction — fresh-agent and
  signal doors now refuse sessions owned by a live REST terminal, because REST
  creates finally publish identity rows. The REST *terminal* door still
  performs no cross-kind check (`terminal_tabs.rs` contains no
  `has_live_session` reference on `6147c700`), and #584's own plan records its
  LB-11 residual cross-kind race as explicitly out of its scope, so the
  deterministic hole D4 targets is still open and B0 still closes it.
- **D5 — Remove legacy (non-negotiated) WS session-carrying creates.** A
  `terminal.create` that carries session identity on a connection that did not
  negotiate `pane_reconcile_v1` is rejected with a deterministic structured
  error telling the client to refresh; the legacy check-then-spawn code path
  for session-carrying creates is removed, with a regression test.
  **Verified scope:** `create_session_locator`
  (`crates/freshell-ws/src/terminal.rs:1167-1182`) returns `None` for
  `mode == "shell"` and for creates with no session id, so plain-shell and
  identityless creates never enter the claim path and **remain allowed** on
  legacy connections. Only session-identity-carrying creates require the
  negotiated protocol. An F5 upgrades the client, which this same server
  serves.
- **Standing constraints (already in force):** no accepted **admission**
  race anywhere in this plan or its report — every create/attach/resume door
  claims atomically and the barrier suite proves exactly-one-winner; the
  sole documented exposure is the D3-clarified late-discovery window, which
  must be stated honestly (refused + poisoned + alarmed, bounded by user
  action) and never described as prevented; tests use fake
  provider homes and temp directories only; never touch port 3002 or the
  preserved evidence bundle; no PR until the user explicitly approves one.

## Out of Scope

- Any Gemini/Kimi identity-model change beyond preserving today's behavior
  (deprecation is kata `jb4z`).
- Redirect-the-loser-to-the-existing-pane UX (D2 chose refusal).
- Any policy that kills — or freezes/suspends — a running provider process
  on a discovered-identity collision (D3-clarified chose accept + alarm:
  refuse, hold, alarm, leave running).
- An ack/barrier transport protocol for instantaneous client consistency
  (LB17: eventual convergence with handshake-inventory resync is accepted).
- PR creation, push, deploy, or any action against live port 3002.
- Node server behavior changes and client selector changes.

## Validation Provenance

Every architectural rule below traces to a validated finding. Summary:

| Finding | Verdict | Encoded in |
| --- | --- | --- |
| LB1 strong Arc cycle | Falsified | Lifecycle Corrections; Slice D (weak probes + teardown test) |
| LB2 sink wiring unproven | Falsified as invariant | Slice D (5-consumer wired + `Arc::ptr_eq` boot asserts) |
| LB3 lock order | Confirmed under contract | Callback Contract; Slices B/D |
| LB4 gate on error/unwind | Inconclusive → must design | Slice B (guard-on-drop, duplicate-id, abort-wrapper tests) |
| LB5 pre-spawn Bound window | Falsified | No new pre-spawn ledger writes; PIN2 minted-Claude lane kept as the one bounded exception (Lifecycle Corrections) |
| LB6 exit races settlement | Falsified | Slice B (settlement-owner-held finalization guard; FE9 detached-task ownership) |
| LB7 blanket Closed retirement | Falsified | Exit-cause model; Slices D/E2/F4 |
| LB8 terminal-id-only cleanup | Falsified | Slice C (`retire_closed_if_owned`, epoch-keyed pending) |
| LB9 retired OpenCode missing row | Falsified | Slice F3 (absent-row retired lane preserved) |
| LB10 rejected-resume residue | Confirmed | Launch Hint vs Authority consumer table |
| LB11 duplicate read models | Confirmed | Slice G (reconcile echo scoped; one-key regression) |
| LB12 cold existence permanence | Confirmed | Deferred re-authorization (Slice F5) |
| LB13 liveness after existence | Confirmed | Authorization order: live-owner first (Slice D) |
| LB14 cross-kind two writers | Confirmed (deterministic on REST) | `SessionAdmission` (Slice B0) |
| LB15 amplifier stub self-auth | Confirmed | Probe-before-stub (Slice E2) |
| LB16 Gemini/Kimi omission | Confirmed | D1 carve-out |
| LB17 transport ordering | Confirmed | Enqueue-before-return wording; Slice H |
| LB18 sink unimportable | Confirmed | Sink moves to `freshell-ws` (Slice D) |
| LB19 task graph infeasible | Confirmed | Slices A–J (G5's corrected graph) |
| LB20 amplifier stub adoption | Confirmed (contract holds) | Pinned contract version (Slice I) |

### Fresh Eyes Round 1 (GPT; verdict: failed — every finding encoded here)

| # | Finding (condensed) | Resolution — encoded in |
| --- | --- | --- |
| FE1 (critical) | Publisher panic under the registry `std::sync::Mutex` poisons it; every later `.lock().expect` panics; the PTY is stranded | Callback Contract: panic-free-by-construction + abort-on-panic wrapper (never `catch_unwind`-and-continue); Slice B tests |
| FE2 | Base pinned to stale `537d7d09`; the rebase onto `6147c700` is already done | Global Constraints; Preflight; Slice E1 marked landed; E2 reframed (old RED tuple impossible) |
| FE3 | Plan forbade `PaneIdentityBinder`, which main now ships with an awaited pre-spawn Claude binding | "Reconciliation with Merged PR #584": absorb + migrate + delete; LB5 rescoped to the PIN2 exception; Slices D/E2 |
| FE4 | `SessionRefClaim::OwnedByFreshAgent` breaks `auto_resume.rs:651-681`'s exhaustive match | Slice B0 file inventory + refusal arm + test |
| FE5 | New `WsState` field breaks ~38 struct-literal construction sites | Slice D enumerates every site + `null_sink_for_tests()` one-liner; full `--all-targets` compile gate |
| FE6 | Warm-looking `Absent` can come from a stale snapshot (`server/existence.rs:181-215`); `SessionExistence` carries no freshness | Probe contract gains `exists_with_freshness`; stale `Absent` is deferrable, fresh `Absent` permanent (Authorization Ordering; Slices D/F5) |
| FE7 | `ProviderUnavailable` classified deferrable but a missing root "will never warm up" and no refresh-completion API exists | Reclassified **permanent**; F5's deferral trigger is a bounded fresh-answer requery schedule (no new subscription API) |
| FE8 | Plan required a "REST explicit-close door" that does not exist (pane/tab DELETEs keep PTYs; `DELETE /api/terminals/:id` only hides) | `Closed` retirement scoped to WS `handle_kill` only; REST kill route explicitly out of scope (Lifecycle Corrections LB7) |
| FE9 | Caller-held guard dies with the HTTP handler on client abort, opening the gate prematurely | Guard held by the **detached settle task** (the settlement owner, which already survives client aborts); cancellation test in Slice E2 |
| FE10 | Two invalid REST claude shapes launch bare unresumable processes (restore:true w/o identity; cross-provider parsed ref) | REST rejection ladder: 400 `SESSION_REF_PROVIDER_MISMATCH`, 422 `CLAUDE_RESTORE_UNRESOLVED` (WS `error_claude_restore_unresolved` mirror) + route-matrix tests (Slice E2) |
| FE11 | Same-kind `BoundLive` "adopt" is unsafe at discovery time (different owner, same provider) | `claim_discovered` distinguishes exact-same-owner (idempotent) from **any** different owner (atomic refusal, loud error, process left running — D3); Slice B0 tests |

### Fresh Eyes Round 2 (GPT; verdict: failed — every finding encoded here)

| # | Finding (condensed) | Resolution — encoded in |
| --- | --- | --- |
| FE-R2-1 (critical) | `BoundOwner` had no generation token while `clear_binding(provider, sid)` facades survived; codex clears the binding twice (watcher `codex.rs:3287/3295`, then `handle_kill` awaits the watcher and clears again at `codex.rs:1245`) — a replacement binding on the same key between the two clears is erased and admission reopens under a live writer | Table-minted `AdmissionEpoch` inside every `BoundOwner`; every cleanup call carries the token; the epochless `clear_binding` facade is deleted; call-site migration enumerated; `stale_epoch_clear_cannot_release_a_replacement_binding` + `codex_double_clear_cannot_release_a_replacement_binding` (Slice B0) |
| FE-R2-2 (critical) | A refused discovery collision (D3: process left running) was invisible to `SessionAdmission`; when the original owner exits, the key frees while the refused process may still be writing | Refusal installs a **conflict hold** that poisons the key until the refused process exits; `refused_discovery_poisons_key_until_refused_process_exits` + poisoned-retry barrier variant (Slice B0) |
| FE-R2-3 | `AdmissionClaim::Held` omitted the holder kind, so facades could not distinguish D2 cross-kind `RESTORE_UNAVAILABLE` from same-kind D8 `SESSION_RESERVED` | `Held`/lease records expose `HolderKind`; per-door error mapping specified; barrier tests assert the exact loser error for same-kind AND cross-kind contention (Slice B0) |
| FE-R2-4 | Base pinned to `6147c700`; `origin/main` moved to `c5e9fdaa` | Base refs updated; drift verified crate-empty (PR #585 deck visuals only); the Preflight gate now targets "current `origin/main` at implementation start" so it cannot go stale the same way again |
| FE-R2-5 | `SessionIndex::peek()` and `is_fresh()` are separate lock acquisitions (`directory_index.rs:751-759`; the backing `fresh_cached()`/`any_cached()` helpers each take `self.snapshot.lock()` independently, `directory_index.rs:763-777`); a refresh can interleave and pair a stale `Absent` with `index_fresh: true` → wrongful permanent rejection | New atomic `peek_with_freshness()` (one lock, snapshot + freshness + generation) in `freshell-sessions`; `IndexExistenceProbe::exists_with_freshness` uses only it; file map + Slice D inventory + test |
| FE-R2-6 | F5 stops at the first `index_fresh: true` answer but fresh `Unknown` is possible (OpenCode by-id fallback `Unreadable → Unknown` inside the warm-snapshot arm, `server/existence.rs:268-270`) | Fresh `Unknown` never terminates the schedule: bounded requery continues, exhaustion drops with a structured warning; `fresh_unknown_answers_continue_the_bounded_requery` (Slice F5) |
| FE-R2-7 | The plan made pending-marker deletion `ExplicitClose`-only, but natural exit must delete durable PENDING markers (current behavior; ported binder pin `retire_pane_identity_retires_row_and_clears_pending`, `pane_identity_binder.rs:267-310`) | `retire_terminal_identity` runs the epoch-guarded pending delete on **every** exit cause; only ledger `Closed` retirement stays explicit-close-only; ported test kept intact (Lifecycle Corrections; Slices D/E2) |
| FE-R2-8 | The sink's fire-and-forget retirement job broke `handle_kill`'s awaited ledger retirement (`ws/terminal.rs:3880-3903`): a kill response + crash could leave a `Bound` row | `retire_terminal_identity` returns an awaitable `TerminalRetirementCompletion`; `handle_kill` awaits it before completing; `handle_kill_awaits_ledger_retirement_before_completing` (Slices D/F4) |
| FE-R2-9 | Detached-settle-task guard ownership vs REST `ui.command`-first announcement was unimplementable as specified (routes build `ui.command` after the spawn helper returns; Slice H forbids lower-helper announcement) | Two-phase settle handoff — **but revision 3's shape was itself circular (the route awaited the settle `JoinHandle` for the spawn result while the settle task awaited the route's closure); superseded by FE-R3-8's phase-one result channel design.** Revision 3's fix commit overstated this as resolved |
| FE-R2-10 | `OnceLock::set(...).expect(...)` does not compile (`Err(Arc<dyn PaneIdentitySink>)` is not `Debug`) | Boot wiring specified as `assert!(cell.set(sink).is_ok(), "identity sink wired twice")` (Sink Placement and Boot Wiring) |
| FE-R2-11 | Preflight/E1 `--exact` commands used the bare test name, matching zero tests → vacuous green | Fully qualified `cli_launch::tests::fresh_claude_preallocation_predicate_truth_table`; global convention: every focused command must show a nonzero selected-test count (never `running 0 tests`) |
| FE-R2-12 | F5's focused command named an undeclared test; the bounded-exhaustion and fresh-Unknown tests were missing | F5 test list redeclared (five tests) and every focused command matches a declared name exactly (Slice F5) |
| FE-R2-13 | The new Rust-only Playwright spec was not added to `test/e2e-browser/playwright.config.ts` | Spec added to BOTH the `rust-chromium` `testMatch` allowlist and `RUST_ONLY_SPECS`; config file in Slice I inventory + commit (Slice I) |
| FE-R2-14 | The real OpenCode contract command omitted `--config config/vitest/vitest.server.config.ts` (default config excludes `test/integration/real/**`) → would not execute | Command fixed to mirror the amplifier one (Slice I) |
| FE-R2-15 (minor) | Type-family comment labeled `ProviderUnavailable` deferrable, contradicting the correct permanent classification | Comment fixed (Slice A type family) |

### Fresh Eyes Round 3 (GPT; verdict: failed — every finding encoded here; D3 clarified by the user in response to the critical)

| # | Finding (condensed) | Resolution — encoded in |
| --- | --- | --- |
| FE-R3-1 (critical) | The conflict hold cannot make "leave it running" satisfy "two writers can never open one provider session file" — it only prevents a *third* admission; both colliding writers are already attached when discovery fires | **D3 clarified: ACCEPT + ALARM.** The headline invariant is restated honestly at every occurrence (Goal, D3, Global Constraints, admission section, acceptance summary, barrier tests): two writers are never **admitted**; a late-discovered collision is refused, poisoned, and loudly alarmed, exposure bounded by user action. Concrete alarm surface (invariant log per the verified log-only D8 mechanism `registry.rs:2377-2389` + `session.collision.detected` extension frame + client banner) and an explicit "Residual exposure" paragraph ("Admission invariant, stated honestly") |
| FE-R3-2 | `claim_discovered(provider, sid, kind)` cannot implement exact-owner idempotency (needs kind AND epoch equality) | Signature takes the caller's prior token: `claim_discovered(provider, sid, claimant, prior: Option<&BoundOwner>)`; idempotent only when `prior` equals the live binding (kind AND epoch); tests realigned (Cross-Kind section; Slice B0) |
| FE-R3-3 | `ConflictHold`/`release_conflict_hold` discarded the epoch — a stale release could free a reinstalled hold | Holds carry a table-minted `HoldEpoch` inside a returned `ConflictHoldHandle`; installs dedupe per (key, holder identity); release is hold-epoch-conditional; duplicate-install and stale-release tests (Slice B0) |
| FE-R3-4 | The discovery algorithm had no ownership/rollback paths (leaked claims on rejection; no stored token for the exit hook; no stored hold handle for a refused terminal) | Helper rolls back a freshly minted claim on any authorization/publication failure; the minted `BoundOwner` is stored on the terminal's registry-row admission record (`store_admission_token`, under the registry lock) and the refusal's `ConflictHoldHandle` likewise (`store_conflict_hold`); exit hook releases from the stored records; claim-vs-exit and rejection-rollback tests (Slice F1) |
| FE-R3-5 | Live rebinds (codex fork, claude/opencode signal switch) never transferred/released the old admission binding — the old key stayed closed forever and the new key was unprotected | Atomic `rebind_discovered(provider, old_sid, old: &BoundOwner, new_sid, claimant)` — release A + claim B in one lock scope, epoch-conditional on A; fork/signal publication paths route through it and store the updated token; A-reopens/B-protected tests (Slice B0 table tests; Slices F2/F3) |
| FE-R3-6 | The all-candidate live-owner check had no self-exemption: a deferred legacy resume's own Running row (`resume_session_id == candidate`) would make F5's fresh-`Present` re-authorization reject itself | The registry live-owner join excludes the candidate's own `terminal_id`; authorization never consults the admission table, so the row join was the only self-collision vector; F5 test 1 asserts publication with the candidate's own row Running + sink unit test (Authorization Ordering; Slices D/F5) |
| FE-R3-7 | `AdmissionClaim::Poisoned` exposed no holder kind, so same-kind poisoned contention couldn't map to `SESSION_RESERVED` vs cross-kind `RESTORE_UNAVAILABLE` | `Poisoned { holders: Vec<BoundOwnerKind> }`; WS-door mapping rule (all-Terminal holders → D8 `SESSION_RESERVED`; any FreshAgent holder → `RESTORE_UNAVAILABLE`); table + door tests (Cross-Kind section; Slice B0) |
| FE-R3-8 | The two-phase REST handoff was circular: the route awaited the settle `JoinHandle` (`terminal_tabs.rs:1144-1165`) and built `ui.command` only after it returned (`terminal_tabs.rs:1902-1950`), yet the settle task waited for that `ui.command` closure | **Phase-one result channel** redesign: the settle task sends the creation result over a oneshot *without finishing*, receives the announcement plan, re-checks the row, enqueues, acks, then drops the guard; the route never awaits the `JoinHandle` mid-phase; deterministic sender-drop fallbacks, no timeouts (Lifecycle Corrections; Slices E2/H) |
| FE-R3-9 | Duplicate-terminal-ID rejection could corrupt the pre-existing terminal: the dropped uninserted `PtyTerminal` kills its child (`pty.rs` Drop, :440-451) and its reader invokes the ID-keyed exit hook (`pty.rs:507-515`), which can `finish_pty_exit` the real row once the gate opens | Terminal-id **pre-reservation under `RegistryInner` before PTY spawn**: duplicates are rejected before any `PtyTerminal` exists, so no orphan hook can ever fire; reservation released on every failure path; rewritten duplicate-ID tests prove the pre-existing terminal stays Running (Slice B) |
| FE-R3-10 | Kill-during-settlement could announce `Created` for an already-killed terminal (`kill_internal` removes + marks exited before dropping the PTY, `registry.rs:1444-1503`; the gate blocks only the reader hook) | The settle task re-checks the row is still present/Running under the registry immediately before enqueueing; on failure it skips `Created`/`ui.command`, enqueues `terminals.changed` only, and runs epoch-conditional persistence cleanup; barrier test (Lifecycle Corrections; Slice E2) |
| FE-R3-11 | `retire_terminal_identity(terminal_id)` couldn't drive epoch-conditional cleanup (`retire_closed_if_owned` needs provider/session/terminal/request ids; `handle_kill` removes the registry row first; reading the current ledger row is tautological) | The sink keeps an immutable **publication-time ownership record** per terminal id (provider, session id, create-request id, admission epoch), inserted on publish, replaced on rebind, removed on retirement completion; retirement resolves expected values from it; replacement-safety test (Slice D) |
| FE-R3-12 | Amplifier admission was not actually sequenced before stub creation (`ensure_session` at `terminal_tabs.rs:940-956` precedes the D7/D8 admission block at `terminal_tabs.rs:1003-1085`) | B0 moves the admission claim ahead of the amplifier `ensure_session`/stub block (stub-before-`registry.create` events-lane constraint untouched); `admission_loser_never_writes_amplifier_stub` (Slice B0) |
| FE-R3-13 | Acceptance tests asserted `AcceptedSessionRef` provenance from the identity registry and reloaded ledger, but no persistence schema stores provenance (`TerminalIdentity`, `identity.rs:34-46`; `BindingRow`, `pane_ledger.rs:93-129`) | **Rescoped to observable facts** (no schema change): persistence assertions cover row existence + exact sessionRef; provenance is asserted at the typed seams — the fake sink's recorded `AuthorizedTerminalIdentity` (Slice E2) and the ws authorize unit tests (Slice D) (Slice I Step 2/3) |
| FE-R3-14 | A `freshell-freshagent` unit test required a reloaded production `PaneLedger`, which that crate cannot import (dependency direction: `freshell-ws → freshell-freshagent`) | E2's route tests observe only the injected `FakeIdentitySink` (calls + typed provenance); directory/identity/reloaded-ledger equality moved to Slice I's `explicit_refs_publish_for_all_four_terminal_providers`; declared test lists/commands updated (Slices E2/I) |

## Global Constraints

- Work only in
  `/home/dan/code/freshell/.worktrees/rest-codex-terminal-identity` on branch
  `fix/rest-terminal-identity-publication`, rebased onto `origin/main`
  `c5e9fdaa` (= `537d7d09` + PR #583 + PR #584 = `6147c700`, + PR #585).
  **That rebase is already done** — verify it, do not redo it (FE-R2-4).
- **File:line fact provenance (FE-R2-4):** every crate-level file:line
  reference in this plan was verified on `6147c700`.
  `git diff 6147c700..c5e9fdaa -- crates docs/superpowers/plans` is empty
  (PR #585 is deck visual work only), so every such reference remains valid
  on `c5e9fdaa`. Where the text says a fact holds "on `6147c700`", read
  "verified on `6147c700`, unchanged through `c5e9fdaa`".
- **Preflight baseline (required before the first implementation slice):**
  the gate targets **current `origin/main` at implementation start**, not
  any SHA written here (pins in this plan go stale as main moves; `c5e9fdaa`
  is only the value as of this revision). Before any implementation commit:
  fetch; if `origin/main` has moved past `c5e9fdaa`, rebase, verify the new
  drift is irrelevant to this plan's crate-level facts
  (`git diff c5e9fdaa..origin/main -- crates` — if non-empty, re-validate
  the affected facts before proceeding); then run the repo-supported
  baseline on that base per `AGENTS.md` (broad suites go through the shared
  test coordinator; never kill a foreign holder), record the result, and
  stop if the base is not green. No recorded baseline exists for this base
  (the old 9,585-pass evidence was for the long-stale `4c04dc9c`).
- Use red/green/refactor TDD with **runtime reds only**: every slice lands its
  test surface together with a compiling minimal stub, so each RED is a
  genuine assertion failure, never a missing-symbol compile error. No commit
  may contain a red test. No Cargo target may be left uncompilable at any
  commit boundary. Trait growth uses temporary default bodies flipped to
  required methods within the same slice.
- Replace this plan in place. Do not create another Codex-only, Claude-only,
  or provider-specific competing plan.
- Rust production server only. Do not add Node server behavior.
- Do not infer authoritative identity merely from
  `mode + resumeSessionId`, CLI argv, a promoted pane payload, title, cwd,
  output text, or an extension manifest. (Gemini/Kimi retain their documented
  legacy carve-out per D1; that carve-out is compatibility, not authority.)
- These are authoritative provenance:
  `AcceptedSessionRef`, `ServerPreallocated`, `ProviderDiscovered`, and
  `ExistenceValidatedLegacyResume`. A raw legacy `resumeSessionId` may launch
  for compatibility, but it becomes authoritative only after the shared
  existence probe returns `Present` — at create time or later through
  deferred re-authorization.
- **One cross-kind admission table.** Every create door (REST terminal, WS
  terminal, fresh-agent create/attach) and every discovery-time adoption
  claims the same `SessionAdmission` key `(provider, canonical session id)`
  before spawning or binding. The reciprocal probes (`terminal_liveness`,
  `has_live_session`) are UX fast paths only, never the defense. There is no
  accepted **admission** race; the barrier tests in Slice B0 are the gate.
  The one honestly documented exposure is the D3-clarified late-discovery
  collision — refused, poisoned, and alarmed, never claimed prevented (see
  "Admission invariant, stated honestly").
- Live-owner checks run for **every** session-carrying candidate — including
  `LegacyResume` — and run **before** existence mapping. A live owner refuses
  the launch even when existence is `Unknown` or `Absent`.
- Preserve the accepted `sessionRef` exactly: nonempty provider must equal
  mode, and the published session id must be the accepted id. If managed Codex
  planning returns a different id, fail before spawn rather than silently
  changing authority.
- Preserve provider-specific launches:
  fresh Claude uses a minted UUID with `LaunchIntent::Start` and
  `--session-id`; explicit Claude resumes use `--resume`; fresh Amplifier uses
  a minted UUID, pre-created stub, `LaunchIntent::Resume`, and the existing
  effective-cwd rules; explicit Amplifier resumes retain the stub/restore
  checks (reordered per LB15: probe-only existence before any legacy stub
  write); fresh OpenCode has no session id in argv; explicit OpenCode resumes
  use `--session`; explicit Codex resumes keep the managed/plain launch
  decision; fresh Codex remains rollout-locator-discovered.
- Never preallocate an OpenCode id. OpenCode 1.18.9 treats `--session <id>` as
  attach/resume and rejects a made-up id with `Session not found`.
- The in-memory guarantee is directional and exact: no identity-bearing
  terminal row may become visible to inventory, directory, activity
  `Created`, or exit retirement before its matching
  `TerminalIdentityRegistry` row is published. Filesystem durability is
  awaited outside the registry lock; announcements are enqueued only after
  that outcome settles.
- **Finalization ordering:** the PTY exit hook must not run until the create
  settlement (provider adoption, durable write, announcement enqueue)
  completes; the **settlement owner** holds a finalization guard whose drop —
  on every success, error, and unwind path — releases the exit hook. The
  settlement owner is the WS handler task on the WS door and the **detached
  settle task** on the REST door (`terminal_tabs.rs` runs spawn + settlement
  on a detached Tokio task that owns the spawn permit precisely so a client
  abort drops only the HTTP handler future, never settlement — FE9). The
  guard must never be held by, returned to, or awaited from the HTTP handler
  future. Because the route builds `ui.command` and its pane/tab bookkeeping
  only after it learns the spawn result, the settle task holds the guard
  through announcement via the **two-phase settle handoff with a phase-one
  result channel** (FE-R2-9 corrected by FE-R3-8, specified in Lifecycle
  Corrections): the settle task sends the creation result to the route over
  a oneshot **without finishing**, receives the route's announcement plan
  over a second oneshot, re-checks the row is still Running (FE-R3-10),
  enqueues, acks over a third oneshot, and only then drops the guard; every
  dropped-sender case falls back deterministically to the deferred-shape
  announcement (no timeouts anywhere). The route never awaits the settle
  `JoinHandle` mid-phase. A locator result racing with exit cannot publish
  identity to a missing or non-running terminal.
- **Exit-cause discipline:** durable ledger rows become `Closed` only on
  explicit user kill — today that is exactly the WS `terminal.kill` door
  (`handle_kill`). **No REST route kills a PTY** (pane/tab DELETEs keep PTYs
  for reattach; `DELETE /api/terminals/:id` only patches a `deleted` settings
  override, `crates/freshell-server/src/terminals.rs:1033-1050`), so no REST
  code path may call the `ExplicitClose` retirement; adding a REST kill route
  is out of scope (FE8). Natural PTY exit, auto-resume settlement, and
  graceful shutdown leave rows `Bound`. In-memory identity is marked retired
  (retained, not deleted) on every exit so the trusted retired-signal lane
  keeps working. New exit machinery must not race or suppress the current
  `auto_resume_cancels`/settle-frame behavior.
- **Epoch-conditional cleanup:** every delayed mutation (ledger retire,
  pending delete, admission binding clear) carries the owning terminal id
  (and create-request id where available) and mutates only if it still owns
  the row/key. Admission binding clears additionally carry the table-minted
  `AdmissionEpoch` inside the `BoundOwner` token (FE-R2-1), and conflict-hold
  releases carry the minted `HoldEpoch` inside the stored
  `ConflictHoldHandle` (FE-R3-3) — a key string
  alone is never ownership proof, because keys are reused across
  generations. Never let old cleanup erase a replacement owner.
- **Transport ordering claims are enqueue claims.** The server guarantees
  frames are enqueued to the broadcast bus, in order, before the HTTP handler
  returns — and per-socket FIFO delivery for connected subscribers. It cannot
  guarantee the browser observes frames before the HTTP response. The
  reconnect handshake inventory (identity + ledger stamped,
  `crates/freshell-ws/src/lib.rs:455-470`) is the authoritative resync for
  missed frames, including the bounded-bus 4008 lagged-close case
  (`crates/freshell-ws/src/terminal.rs:407-423`).
- `TerminalIdentityDurability::Degraded` never kills an otherwise successful
  terminal. Surface exactly one `durability.degraded` frame for the settled
  identity event and return the normal success response.
- Preserve create dedupe, spawn-gate ownership, detached settlement, managed
  Codex adoption, locator arming, Amplifier stub GC, restore-key replay,
  pane/tab bookkeeping, and PTY process-group kill discipline. D7/D8
  semantics are preserved through the `SessionAdmission` facades; the D8
  lease/binding maps move, their observable behavior does not (except the
  new cross-kind answers).
- Keep pane-ledger I/O on `spawn_blocking`. Synchronous publication does no
  filesystem I/O, does not await, and does not re-enter `TerminalRegistry`
  (see Callback Contract).
- Keep client selector behavior unchanged. The server publishes canonical
  identity and ordered invalidations; the client regression proves the stale
  fallback disappears without a selector patch.
- Every test uses injected temp directories and fake provider executables.
  Never touch the user's provider homes, pane ledger, signal roots, or
  preserved evidence bundle.
- Do not build, deploy, stop, or restart live port 3002. Do not create a PR.

---

## Incident and Established Evidence

The plan must retain the actual incident, not a genericized approximation:

| Fact | Preserved evidence |
| --- | --- |
| Real History key | `codex:019f9cb3-f11e-79f3-a968-287a5bc5798c` |
| Synthetic duplicate key | `codex:terminal:8f673dee-3160-45cd-91ec-e5411eb5523d` |
| Pane/tab title and cwd | `gf ui`, `/home/dan/code/glowforge` |
| Process | Exactly one `codex resume 019f9cb3-f11e-79f3-a968-287a5bc5798c` |
| Pane state | Correct canonical `sessionRef` |
| `/api/terminals` | Same live terminal, missing `sessionRef` |
| Pane ledger | Still named old terminal `981008…`, not `8f673…` |
| Preservation | 132 files passed the evidence bundle's SHA-256 manifest |

The failure chain is exact:

1. A recovery agent called the REST `new-tab` path with the real Codex
   `sessionRef`.
2. `POST /api/tabs` spawned the correct resumed process, completed the D8
   registry binding, and put the correct identity in pane content.
3. The REST path skipped `TerminalIdentityRegistry` and `PaneLedger`, unlike
   `terminal.create`.
4. `/api/terminals` deliberately did not infer Codex identity from the resume
   argv, so the terminal row remained unidentified.
5. The selector correctly emitted the pane's real session key and the
   unidentified terminal's synthetic fallback key. Both focused the same tab.

**Status on `6147c700`: the incident itself is FIXED.** PR #584's
`LedgerPaneIdentityBinder` post-spawn identity-registration block in
`terminal_tabs.rs` writes the identity row and ledger binding for every
non-shell session-carrying REST create, and
`crates/freshell-ws/tests/rest_locator_identity.rs` pins the codex/opencode
REST create → identity row + ledger binding end to end (claude:
`rest_claude_identity.rs`). The incident is retained here as the motivating
shape and becomes a permanent **green pin** (Slice I) — the old E2 RED tuple
`(None, None, Some("981008-old-gf-ui"))` can no longer occur. What remains is
the architecture that makes the fix principled (provenance + authorization —
the landed binder publishes even unvalidated legacy raw ids) plus the holes
#584 explicitly left open (its plan's LB-11 documents the residual cross-kind
admission race as out of scope).

Additional established constraints:

- `/api/terminals` currently treats non-Codex `mode + resume_session_id` as a
  `sessionRef` (`crates/freshell-server/src/terminals.rs:686-698`); this is
  not a valid provenance rule for claude/codex/opencode/amplifier and is
  removed for those providers once all authoritative publishers are wired —
  and retained verbatim for gemini/kimi per D1.
- The existing Amplifier REST path already mints a UUID, resolves one
  effective cwd, and writes the provider stub before launch. Reuse it; the
  only reorder is LB15's probe-before-stub for legacy raw ids. The
  stub-before-`registry.create` events-lane constraint
  (`terminal_tabs.rs:800-965`) is load-bearing and preserved.
- The existing OpenCode locator already performs the right broad fan-out after
  discovery—identity registry, registry metadata, binding row, pending-marker
  deletion, and client metadata—but does each step separately. Move that
  fan-out behind the shared publisher.
- Current OpenCode 1.18.9 evidence proves arbitrary `--session` preallocation
  is invalid. This plan intentionally keeps launch-time identity absent for a
  fresh OpenCode CLI.
- **G4 evidence (drives Slice B0):** Terminal D8 leases
  (`crates/freshell-terminal/src/registry.rs:579,1933-2123`) and
  `FreshAgentSessionLeases`
  (`crates/freshell-freshagent/src/session_lease.rs:215-347`) are two
  separate lock domains joined only by read-only probes that are blind for
  the entire spawn window. The REST terminal door has **no** cross-kind check
  at all (`terminal_tabs.rs` contains no `has_live_session` reference), so a
  REST terminal resume of a live fresh-agent-owned session spawns a second
  writer **deterministically** on current `origin/main`.

## Provider and Provenance Matrix

All session-carrying rows below additionally acquire the `SessionAdmission`
claim before spawn (Slice B0); the matrix shows identity/publication behavior.

| Provider/create shape | Launch-time session source | Launch behavior | Authoritative provenance | Durability timing | Client announcement (enqueue order) |
| --- | --- | --- | --- | --- | --- |
| Fresh Claude | Freshell UUID (minting landed in #584) | `Start`, `--session-id <uuid>` | `ServerPreallocated` | Awaited PIN2 pre-spawn binding (LB5 exception) + post-spawn awaited write | `terminals.changed`, then `terminal.meta.updated` |
| Explicit Claude `sessionRef` | Accepted matching ref | `Resume`, `--resume <id>` | `AcceptedSessionRef` | Post-spawn | Same create announcement |
| Fresh Amplifier | Freshell UUID + provider stub | `Resume`, existing stub/cwd rules | `ServerPreallocated` | Post-spawn | Same create announcement |
| Explicit Amplifier `sessionRef` | Accepted matching ref | Existing resume/stub rules | `AcceptedSessionRef` | Post-spawn | Same create announcement |
| Fresh OpenCode | None at launch | No `--session`; arm existing locator | None until locator | Pending marker after spawn; binding after discovery | Association, changed, metadata |
| Explicit OpenCode `sessionRef` | Accepted matching ref | `--session <id>` | `AcceptedSessionRef` | Post-spawn | Create announcement |
| Fresh Codex | None at launch | Existing plain/managed fresh launch + rollout locator | None until locator | Pending marker after spawn; binding after discovery | Association, changed, metadata |
| Explicit Codex `sessionRef` | Accepted matching ref | Existing plain/managed resume | `AcceptedSessionRef` | Post-spawn | Create announcement |
| Legacy raw resume, indexed `Present` | Raw field | Existing provider resume argv | `ExistenceValidatedLegacyResume` | Post-spawn | Create announcement |
| Legacy raw resume, `Unknown` (cold index) or `Absent` from a **stale** snapshot (FE6) | Raw field | Compatibility launch; row keeps the launch hint | Not yet authoritative; **deferred re-authorization** (bounded fresh-answer requery, Slice F5) publishes via the discovered pipeline on fresh `Present` | None until re-authorized | `terminals.changed` at create; `associated -> changed -> meta` on late authorization |
| Legacy raw resume, `Absent` from a **fresh** index, or `ProviderUnavailable` (missing provider root — the probe contract says it never warms on this machine, FE7) | Raw field | Compatibility launch; row keeps the launch hint | Permanently non-authoritative; structured warning | None | `terminals.changed` only |
| Parsed `sessionRef` whose provider ≠ mode (any of the four providers, FE10) | — | **Rejected before spawn:** REST 400 `SESSION_REF_PROVIDER_MISMATCH`; WS keeps its existing mismatch rejection | — | — | Error response only |
| Claude `restore: true` with no accepted ref and no resume id (FE10) | — | **Rejected before spawn:** REST 422 `CLAUDE_RESTORE_UNRESOLVED` (mirror of WS `error_claude_restore_unresolved`, `terminal.rs:1708`). Amplifier's documented restore-bare carve-out is unchanged | — | — | Error response only |
| Gemini/Kimi (any restore shape) | Raw field | Existing launch, **entirely unchanged** (D1 carve-out) | Outside the model; directory synthesis and pane promotion retained verbatim | Existing behavior | Existing behavior |
| Shell/custom identityless mode | None | Existing launch | None | None | `terminals.changed` only |

Provider discovery for fresh Codex is migrated behavior-preservingly because it
already shares the same write tail as OpenCode. This does not add Codex
preallocation or change when its rollout locator may bind.

Note on LB15's deliberate behavior change: a legacy raw Amplifier id whose
directory was GC'd previously restored silently via automatic re-stub
(`requested_amplifier_resume_with_missing_dir_is_restubbed_under_same_id`);
under this plan a **legacy** raw id is existence-authorized with a probe-only
lookup first, so that case now fails loudly instead of fabricating provider
state. `ServerPreallocated` and `AcceptedSessionRef` re-stub behavior is
unchanged. The existing test is rescoped to previously-authorized ids.

## Cross-Kind Session Admission (`SessionAdmission`)

New module `crates/freshell-terminal/src/session_admission.rs` (reachable by
both doors with no dependency cycle: `freshell-freshagent → freshell-terminal`,
`freshell-ws → both`, `freshell-server → all`).

```rust
// Keyed by canonical (provider, session_id) — ONE canonicalization fn shared
// with session_ref_key/lease_key (claude UUID casing, opencode "ses_" ids,
// codex thread ids).
pub enum HolderKind { Terminal { conn: u64 }, FreshAgent }
pub enum KillHandle { Pty { pid: u32 }, SidecarTree { pid: u32, ownership_id: String } }

/// Table-minted, table-global, monotonically increasing, never reused
/// (FE-R2-1). Minted inside `complete`/`claim_discovered` under the one
/// admission lock; the session key alone is NOT an ownership identity,
/// because keys are reused across generations of the same session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdmissionEpoch(u64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoundOwnerKind {
    Terminal { terminal_id: String },
    FreshAgent { live_session_key: String },
}

/// The binding token. `complete`/`claim_discovered` mint and RETURN it; the
/// caller retains it and must present it to every later cleanup call.
/// Equality (kind AND epoch) is the only thing cleanup honors (FE-R2-1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundOwner { pub kind: BoundOwnerKind, pub epoch: AdmissionEpoch }

pub enum AdmissionClaim {
    Acquired,
    // Holder kind exposed so each door maps same-kind vs cross-kind
    // contention to its exact error (FE-R2-3, D2).
    Held { holder: HolderKind, retry_after_ms: u64 },
    // Idempotent ONLY for the exact same owner; every DIFFERENT owner —
    // same kind or cross kind — refuses (FE11; see "Owner-conflict answers").
    // `owner.kind` tells the facade which kind holds the binding.
    BoundLive { owner: BoundOwner },
    ExpiredNeedsKill { handle: KillHandle },
    // FE-R2-2: the key is poisoned by one or more conflict holds — a
    // refused-but-still-running writer exists. Never adoptable, never
    // freed by the original owner's exit alone. FE-R3-7: the holders'
    // kinds are exposed so the WS terminal door can map same-kind
    // poisoned contention to D8 `SESSION_RESERVED` and anything involving
    // a FreshAgent holder to `RESTORE_UNAVAILABLE` (see the per-door
    // mapping below).
    Poisoned { holders: Vec<BoundOwnerKind> },
}

/// FE-R3-3: minted from the SAME table-global monotone counter as
/// `AdmissionEpoch`, never reused. A hold identity is (key, holder,
/// hold-epoch); release honors only an exact match.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HoldEpoch(u64);

/// Returned to the refused caller by `claim_discovered`/`rebind_discovered`
/// and stored on the refused terminal's registry row (FE-R3-4c); presented
/// back on the refused process's exit path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictHoldHandle {
    pub provider: String,
    pub session_id: String,
    pub holder: BoundOwnerKind,
    pub epoch: HoldEpoch,
}

/// FE-R2-2: a refused discovery collision (D3-clarified leaves the refused
/// process running) is a live writer the table must keep representing.
/// Installed by the refusing `claim_discovered`/`rebind_discovered`;
/// released only by the refused process's own exit path, hold-epoch-
/// conditionally (FE-R3-3). Installs are DEDUPED per (key, holder
/// identity): a locator re-fire for the same refused holder returns the
/// existing handle (same epoch), never stacks a second hold.
struct ConflictHold { holder: BoundOwnerKind, epoch: HoldEpoch, installed_at_ms: u64 }

/// FE-R3-2/FE-R3-5: the discovery/rebind answer.
pub enum DiscoveredClaim {
    /// First bind: the table minted a fresh `BoundOwner`. The caller MUST
    /// store it (registry row admission record / fresh-agent session
    /// entry) and roll it back with `clear_binding_if_owner` if
    /// authorization or publication fails afterwards (FE-R3-4a).
    Bound { owner: BoundOwner },
    /// The caller's `prior` token equals the live binding (kind AND
    /// epoch): idempotent re-publication of an established fact. Nothing
    /// was minted; a later failure must NOT clear (the binding predates
    /// this call).
    AlreadyBoundToCaller { owner: BoundOwner },
    /// Any different owner, or a poisoned key: refused atomically; a
    /// deduped `ConflictHold` for `claimant` was installed in the same
    /// lock scope; the caller stores `hold` for its exit path (FE-R3-4c)
    /// and fires the D3 alarm surface.
    Refused { conflict: DiscoveredConflict, hold: ConflictHoldHandle },
}

pub enum DiscoveredConflict {
    OwnedBy(BoundOwner),
    Poisoned { holders: Vec<BoundOwnerKind> },
}

pub struct SessionAdmission {
    // ONE std Mutex over all three maps — the same lock discipline both
    // existing maps already use.
    inner: Mutex<Inner>,
    // Inner: {
    //   leases:    HashMap<Key, Lease>,          // Lease records HolderKind
    //   bindings:  HashMap<Key, BoundOwner>,
    //   conflicts: HashMap<Key, Vec<ConflictHold>>, // poison set (FE-R2-2)
    //   next_epoch: u64,   // mints AdmissionEpoch AND HoldEpoch (FE-R3-3)
    // }
}
```

API: `claim(provider, sid, holder_id, kind, now_ms)`, `set_kill_handle`,
`complete(…, BoundOwnerKind) -> BoundOwner` (binding insert + lease removal
in one lock scope, preserving the existing TOCTOU closures at
`registry.rs:2103-2116` and `session_lease.rs:218-221`; mints and returns the
epoch token — FE-R2-1), `fail`,
`clear_binding_if_owner(provider, sid, expected: &BoundOwner)`
(epoch-conditional: kind AND epoch must match; a stale token is a no-op
`NotOwned`, never a release), `release_for_conn(conn)` (Terminal holders
only), `force_release_after_confirmed_kill`,
`claim_discovered(provider, sid, claimant: BoundOwnerKind,
prior: Option<&BoundOwner>) -> DiscoveredClaim` for identity-discovered
adoption (FE-R3-2: `prior` is the caller's own earlier-minted token — the
create-time completion token for legacy-resume re-publication, or the token
from this terminal's own earlier `claim_discovered` on a locator re-fire;
idempotent success only when `prior` equals the live binding, kind AND
epoch; refusal installs a deduped `ConflictHold` and returns its
`ConflictHoldHandle` — FE-R2-2/FE-R3-3),
`rebind_discovered(provider, old_sid, old: &BoundOwner, new_sid,
claimant: BoundOwnerKind) -> DiscoveredClaim` (FE-R3-5: one lock scope —
release the `old_sid` binding **epoch-conditionally on `old`** (a stale
token skips the release as `NotOwned`, never touching a replacement
binding), then run the `claim_discovered` logic on `new_sid`; on success
`old_sid` is reopenable and `new_sid` carries a freshly minted token the
caller stores; on refusal `old_sid` is still released — the process
genuinely abandoned it — and `new_sid` is conflict-held), and
`release_conflict_hold(handle: &ConflictHoldHandle)` (called from the
refused process's exit path with the stored handle; releases only an exact
(holder, hold-epoch) match — a stale handle is a no-op — and when the last
hold on a key drops with no binding and no lease, the key frees).

**Key-freeing rule (FE-R2-2):** a key admits a new claim only when it has no
lease, no binding, **and no conflict holds**. The original owner's exit
clears its binding but a poisoned key answers `Poisoned`/refusal (mapped to
the per-door loser errors via the exposed holder kinds — FE-R3-7) until
every refused-but-running process has exited and released its hold. This is
the **containment** half of D3-clarified: the running loser stays visible to
admission for its whole life, so no third writer is ever admitted and the
key can never reopen under a live refused writer. It does **not** undo the
two writers that were already attached when discovery fired — that is the
alarmed, bounded exposure below.

### Admission invariant, stated honestly (D3-clarified, FE-R3-1)

> **Two writers are never ADMITTED.** No create, attach, or resume door can
> spawn or adopt a second writer for one provider session: every door claims
> the same atomic `SessionAdmission` key before spawning or binding, and the
> Slice B0 barrier suite is the gate.
>
> **A late-DISCOVERED collision is refused, poisoned, and loudly alarmed —
> not undone.** Codex and OpenCode reveal a fresh terminal's session id only
> after launch. If discovery reports an id another writer already owns, both
> processes are, at that instant, already attached to one session file. The
> table refuses the binding atomically, installs the epoch-carrying conflict
> hold (no third writer, no reopen), and raises the alarm surface below.
> This plan claims **admission** prevention everywhere and **absolute**
> two-writer prevention nowhere.

**Alarm surface (concrete, code-verified):**

- **Invariant log** — the same mechanism as the existing D8 duplicate-session
  alarm: `TerminalRegistry::alarm_if_duplicate_session_ref` emits an
  ERROR-level `tracing::error!(target: "invariant", …,
  "duplicate_pty_for_session_ref: >=2 live PTYs share one sessionRef")`
  (`crates/freshell-terminal/src/registry.rs:2377-2389`; **verified
  log-only** — it broadcasts no frame, so a frame half is added below). The
  refusal emits the same shape:
  `tracing::error!(target: "invariant", provider, session_id,
  refused_terminal_id, owner_kind, "discovered_session_collision_refused")`.
- **User-visible frame** — one new extension server→client frame
  `session.collision.detected { provider, sessionId, refusedTerminalId,
  ownerKind }`, broadcast to all clients on the shared bus via the
  documented extension lane (`EXTENSION_SERVER_MESSAGE_TYPES`,
  `crates/freshell-protocol/src/server_messages.rs:211-221` — the
  `durability.degraded` precedent: a Rust-server-only frame declared beyond
  the generated inventory, so `npm run contract:generate` shows no drift;
  shape pinned by a Rust test). Emitted by the shared discovery/rebind
  helpers on every `Refused` (Slice F1).
- **UI element** — the client surfaces the frame as a visible, dismissable
  alarm banner (`SessionCollisionBanner`, following the existing banner
  precedents `ReconcileWarmingBanner.tsx`/`TerminalExitBanner.tsx`), wired
  through `src/lib/terminal-invalidation-handler.ts` — verified feasible:
  its `handle()` already branches on loosely-typed `msg.type`
  (`terminal-invalidation-handler.ts:85,108`), so an extension frame needs
  no Zod/schema change (Slice H).
- **Sidebar** — the refused terminal never receives published identity, so
  it is never presented as the session's owner: it keeps its synthetic
  `provider:terminal:<id>` key while the true owner keeps the canonical key.

**Residual exposure (documented, bounded):** the exposure window runs from
the refused process's provider-side attach at launch until the user closes
one of the two writers (discovery + refusal + alarm fire within the
locator's ordinary discovery latency, seconds after launch). During the
window: no third writer can be admitted, every further create/attach/resume
for the key is refused (binding + poison), and both alarm surfaces are
live. The bound is **user action, prompted by the alarm** — freezing or
killing the newcomer is explicitly out of scope (D3-clarified). Doors that
know identity before spawn (accepted refs, minted ids, legacy raw resumes)
can never produce this exposure; it exists only for post-launch discovery
providers.

**Replace the storage, migrate the facades (FE-R2-1).**
`TerminalRegistry::claim_session_ref` keeps its signature and its step-1a
row-join + known-dead pruning (registry locks are taken and released before
the admission lock — the acyclic order documented at `registry.rs:1947-1951`),
but its lease/binding maps delegate to an injected `Arc<SessionAdmission>`;
`complete_session_ref_claim` stores the minted `BoundOwner` on the terminal
row's admission record so the exit hook and known-dead pruning clear with
the exact token. `FreshAgentSessionLeases` becomes a thin facade over the
same `Arc` (its kill-tree machinery in `session_lease.rs:65-188` stays; only
map storage moves) — **but its `complete` (`session_lease.rs:330`) now
returns the minted `BoundOwner`, and its epochless
`clear_binding(provider, session_id)` (`session_lease.rs:363`) is DELETED in
favor of `clear_binding_if_owner(provider, sid, &owner)`. Every caller
stores the token in its session entry and presents it on cleanup. Complete
production call-site migration:** codex watcher, both arms
(`codex.rs:3287` and `codex.rs:3295` — the watcher captures the token at
bind time), codex `handle_kill` (`codex.rs:1245` — reads the token from the
removed session entry; after the awaited watcher already cleared, this
second clear is an idempotent `NotOwned` no-op, and a replacement binding's
NEW epoch can never be erased by it), claude (`claude.rs:1218`), opencode
(`opencode_ws.rs:791`). `main.rs` constructs **one** `SessionAdmission` and
injects it into the registry and all fresh-agent states — the same wiring
precedent as the shared `SpawnGate` and `FreshAgentSessionLeases`
(`main.rs:236-261`). Facade preservation must keep the existing 900-line
lease suite and the D8 registry tests green **with only the mechanical
token-threading edits this migration requires** (e.g.
`clear_binding_reopens_after_the_bound_session_exits` now clears with the
token `complete` returned); no other semantic edits.

**Owner-conflict answers (D2/D3, FE11, FE-R2-3):**

- The facades decide same-kind vs cross-kind from the exposed holder/owner
  kind (`Held.holder`, `BoundLive.owner.kind` — FE-R2-3). The per-door
  mapping is exact and barrier-test-asserted (Slice B0 Step 6):
  - WS terminal door, **same-kind** contention (`Held{Terminal}` /
    `BoundLive{Terminal}` / `Poisoned` whose holders are **all**
    `Terminal` — FE-R3-7) → existing D8 `SESSION_RESERVED` error frame with
    `retry_after_ms` (`terminal.rs:1252,1551` semantics preserved);
    **cross-kind** (`Held{FreshAgent}` / `BoundLive{FreshAgent}` /
    `Poisoned` with **any** `FreshAgent` holder) →
    `error{RESTORE_UNAVAILABLE}` per D2.
  - REST terminal door → 409 for every refusal (existing conservative-v1
    envelope, `terminal_tabs.rs:1069-1085`): same-kind keeps today's 409
    `RESTORE_UNAVAILABLE` body; cross-kind and poisoned answer the same 409
    `RESTORE_UNAVAILABLE` (D2).
  - Fresh-agent doors → same-kind keeps today's
    `SESSION_RESERVED { retryable: true }`; cross-kind and poisoned also
    answer `create.failed{SESSION_RESERVED, retryable: true}` per D2.
- Create/attach doors, same-kind `BoundLive` → existing behavior unchanged:
  terminal doors keep their `BoundElsewhere` semantics; the fresh-agent
  attach flow adopts only **its own** completed binding (exact
  `BoundOwner` token match, kind and epoch).
- Cross-kind `BoundLive` → deterministic refusal, never adoption, mapped per
  the table above. A new `SessionRefClaim::OwnedByFreshAgent` variant
  carries this through the registry facade. **Every exhaustive
  `SessionRefClaim` match gains the new arm in the same slice (FE4)** —
  including `auto_resume.rs::claim_session`
  (`crates/freshell-ws/src/auto_resume.rs:651-681`),
  which answers `false` (a fresh-agent-owned session is never auto-respawned).
- Cross-kind `ExpiredNeedsKill` → v1 answers `Held`/409; the holder's own
  kind performs its kill. No cross-kind sweeping.
- `claim_discovered(provider, sid, claimant, prior)` — discovery-time
  adoption (FE11, FE-R2-2, FE-R3-2): binding absent and no conflict holds →
  bind atomically, mint and return the `BoundOwner` (the caller stores it —
  FE-R3-4b). Binding present and `prior` equals it (**kind AND epoch**) →
  `AlreadyBoundToCaller` (idempotent re-publication of an established
  fact); `prior: None` or any mismatch against a present binding — same
  kind or cross kind — or a poisoned key → `Refused`: the binding is
  refused atomically, a **deduped `ConflictHold` for the refused claimant
  is installed in the same lock scope with its minted `HoldEpoch`**
  (FE-R2-2/FE-R3-3), the process keeps running, and the caller fires the
  D3 alarm surface — the `discovered_session_collision_refused` invariant
  ERROR (same mechanism as the D8 alarm, `registry.rs:2377-2389`) plus the
  `session.collision.detected` broadcast frame (see "Admission invariant,
  stated honestly"). Never kill (D3). A second same-provider process on
  one session is exactly the two-writer shape this plan refuses to admit;
  "same kind" is never a license to steal a binding. The refused holder's
  exit path calls `release_conflict_hold(&stored_handle)`; only then (and
  only with no binding and no other holds) does the key free.
- `rebind_discovered(provider, old_sid, old, new_sid, claimant)` — live
  identity switches (FE-R3-5: codex fork rebind, claude/opencode signal
  A→B switch): the old key's binding is released epoch-conditionally and
  the new key claimed in **one lock scope**, so A reopens exactly when B
  becomes protected; the caller replaces its stored token with the
  returned one. A refusal on B still releases A (the process abandoned it)
  and conflict-holds B with the full alarm surface.

**Spawn-door inventory routed through the claim:** WS `terminal.create`
(negotiated; legacy session-carrying creates are removed per D5), REST
`POST /api/tabs` / split / respawn (including the legacy-raw rung, which
today claims nothing), fresh-agent create and attach for claude/codex/
opencode, auto-resume respawn, OpenCode signal-rebind restart, and recovery
flows. Release paths (every cleanup call presents the minted `BoundOwner`
token — FE-R2-1): terminal spawn failure → existing RAII
`fail_session_ref_claim` guards → facade `fail`; PTY exit/kill →
`clear_binding_if_owner(provider, sid, &owner)` with the token stored at
`complete_session_ref_claim` time (known-dead pruning stays as backstop and
also clears token-conditionally); conn death → `release_for_conn`;
fresh-agent sidecar failure → `fail`; session exit watcher →
token-conditional `clear_binding_if_owner` (codex watcher arms
`codex.rs:3287/3295`; the awaited-watcher-then-clear-again shape in codex
`handle_kill` `codex.rs:1245` becomes an idempotent `NotOwned` no-op that
can never erase a replacement's new-epoch binding); TTL tree-kill →
`force_release_after_confirmed_kill`; **refused-discovery conflict holds
(FE-R2-2/FE-R3-3)** → the refused process's own exit path (terminal exit
hook or fresh-agent watcher) calls `release_conflict_hold` with the
**stored `ConflictHoldHandle`**. **Token/handle storage (FE-R3-4b/c):** on
the terminal side, every minted `BoundOwner` and every refusal's
`ConflictHoldHandle` is stored on the terminal's registry-row **admission
record** under the registry inner lock — `complete_session_ref_claim`
stores create-door tokens; new registry methods
`store_admission_token(terminal_id, owner)` /
`store_conflict_hold(terminal_id, handle)` store discovery-time outcomes —
so the exit hook and known-dead pruning always clear/release with the
exact stored values; fresh-agent callers store both on their session
entry. **Live rebinds (FE-R3-5)** — codex fork and claude/opencode signal
A→B switches — go through `rebind_discovered`, which releases the old key
and claims the new one in one lock scope; the caller replaces its stored
token. Server restart: table is in-memory, like both current maps.

## Launch Hint vs Authoritative Identity (LB10)

The registry row's `resume_session_id` is a **launch fact**: this PTY was
launched with `<cli> resume <id>`. It is never, by itself, authoritative
identity. G3 enumerated sixteen production consumers; this plan splits them
deliberately:

**Launch-fact consumers — keep reading the raw row id (unchanged):** a live
process launched against id X is a real writer on X regardless of
authorization, so liveness, admission, dedupe, and suppression must key on
launch facts:

1. Amplifier create-time duplicate-resume reservation (`registry.rs:859-895`).
2. `live_terminal_ids_for_session_ref` / `live_terminal_for_session_ref` /
   `alarm_if_duplicate_session_ref` (`registry.rs:2242-2278`).
3. `live_session_owner` row arm (`registry.rs:2288-2311`).
4. `has_live_resume` / `has_other_live_resume` (amplifier pre-check, stub GC).
5. Recovery-inventory `live_session_keys` suppression
   (`recovery_inventory.rs:431-448`) — offering X while a writer runs would
   create a second writer.
6. Cross-kind `terminal_liveness` probe (`main.rs:322-344`) — now a fast path
   under `SessionAdmission`, still launch-fact-correct.
7. Activity hub lane attachment (`activity.rs:498-585`) — lanes watch files
   the launched process writes; benign for nonexistent ids.
8. Codex/OpenCode locator arm suppression (`codex_locator.rs:236-240`,
   `opencode_locator.rs:180-195`) — a resume launch is not a fresh launch;
   deferred re-authorization (Slice F5), not the locator, is the late
   identity path for legacy resumes.
9. OpenCode signal guard ladder (`opencode_signal.rs:293-298,449-463`).
10. Invariant checks (`invariants.rs:17,79`), restore/ledger scans
    (`terminal.rs:3144,3172-3176`), D7 gating filters
    (`terminal.rs:1738-1751`, `terminal_tabs.rs:982-1010`),
    `ActivityEvent::Created` payload (`registry.rs:1005-1019`).

**Authority consumers — read only published identity
(`TerminalIdentityRegistry`):**

11. `/api/terminals` `sessionRef` projection for claude/codex/opencode/
    amplifier (Slice G; gemini/kimi carve-out retained).
12. Pane-reconcile authoritative-ref rung 2 and the promoted-claim echo
    (`reconcile.rs:106-135,162-177,244-263`): for the four providers, an
    unpublished promoted claim is no longer echoed back as the pane's
    `session_ref` (Slice G). Gemini/kimi echo retained.
13. WS handshake inventory session stamping (`ws/lib.rs:455-470`) — already
    identity/ledger-based; unchanged.
14. REST pane-content `sessionRef` promotion
    (`terminal_tabs.rs:1703-1712`): for the four providers, stamped only
    from an authorized identity (Slice E2). Gemini/kimi retained.

This split is deliberate and reviewed: gating the liveness/suppression
consumers on authorization (an option G3 sketched) would let a real running
writer on X go unprotected exactly when its id is unvalidated — recreating
the two-writer shape LB13/LB14 exist to kill.

## Authorization Ordering and Deferred Re-Authorization (LB13, LB12)

`authorize_terminal_identity` runs, in order, for every candidate:

1. Shape checks: nonempty provider/session, provider equals mode.
2. **Live-owner checks (all candidates, including `LegacyResume`):** the
   provider-aware fresh-agent probe **and** the registry
   `live_session_owner` join — **with self-exemption (FE-R3-6): the row
   join excludes the candidate's own `terminal_id`.** Without this, F5's
   deferred re-authorization would reject itself: the deferred legacy
   terminal's own Running row carries `resume_session_id == candidate`
   (the launch hint), so the all-candidate check would find "a live
   owner" that is the candidate. The fresh-agent probe needs no exemption
   (a terminal candidate is never a fresh-agent session), and
   authorization never consults the admission table (the door already
   claimed; the candidate's own completed admission binding is therefore
   invisible here) — the row join was the only self-collision vector. A
   live **foreign** owner rejects with `LiveFreshAgentOwner`
   (409/`RESTORE_UNAVAILABLE` at the door) even when existence would be
   `Unknown`/`Absent`. (Defense-in-depth: the atomic defense is the
   door's `SessionAdmission` claim; authorization ordering makes the sink
   safe for discovered candidates and keeps liveness independent of a
   warm disk index.)
3. Only for `LegacyResume`, map existence **with freshness** (FE6 — the
   probe contract gains `exists_with_freshness`, below):
   `Present → ExistenceValidatedLegacyResume`;
   `Absent` from a **fresh** index → `LegacyIdentityAbsent` (permanent);
   `Absent` from a **stale** snapshot → `LegacyIdentityUnconfirmed`
   (deferrable — `IndexExistenceProbe::exists` returns `Absent` from a stale
   snapshot right after kicking a detached refresh,
   `crates/freshell-server/src/existence.rs:181-215`, proven convergent by
   `session_written_after_cold_read_resolves_present_on_requery`;
   `SessionExistence` alone carries no freshness, so `Absent` may never be
   treated as permanent without the freshness bit);
   `Unknown → LegacyIdentityUnconfirmed` (deferrable);
   `ProviderUnavailable → ProviderUnavailable` (**permanent** — FE7: the
   probe contract states a known provider whose session root does not exist
   on this machine "will NEVER warm up"; there is nothing to defer to).
4. All other authoritative sources convert directly to matching provenance.

**Probe-contract extension (Slice D, FE6):** `SessionExistenceProbe` gains

```rust
pub struct ExistenceAnswer {
    pub existence: SessionExistence,
    pub index_fresh: bool,
}

fn exists_with_freshness(&self, provider: &str, session_id: &str)
    -> ExistenceAnswer;
```

with a default body delegating to `exists` with `index_fresh: false`
(conservative: an unknown-freshness `Absent` defers instead of permanently
rejecting). The `SharedExistenceProbe` alias in
`crates/freshell-ws/src/existence.rs` carries the same shape. Authorization
uses only `exists_with_freshness`.

**Atomic snapshot+freshness read (FE-R2-5):** `SessionIndex::peek()` and
`is_fresh()` are two separate lock acquisitions
(`crates/freshell-sessions/src/directory_index.rs:751-759` — the backing
`any_cached()` and `fresh_cached()` helpers each take `self.snapshot.lock()`
independently, `directory_index.rs:763-777`), so a
refresh interleaving between them could pair a **stale** `Absent` snapshot
with `index_fresh: true` — turning a deferrable miss into a wrongful
permanent rejection. `IndexExistenceProbe` therefore must NOT compose
`peek()` + `is_fresh()`. `freshell-sessions` gains one atomic API (Slice D):

```rust
pub struct PeekedSnapshot {
    pub items: Option<Arc<Vec<IndexedSession>>>,
    pub fresh: bool,        // fetched_at.elapsed() < ttl, same guard read
    pub generation: u64,    // monotone publish counter, same guard read
}

/// One acquisition of `self.snapshot`'s lock; items, freshness, and
/// generation all derive from the SAME guard read.
pub fn peek_with_freshness(&self) -> PeekedSnapshot;
```

(`SnapshotCache` gains the `generation` counter, bumped on every publish.)
`IndexExistenceProbe::exists_with_freshness` calls `peek_with_freshness()`
exactly once and derives both the existence answer and `index_fresh` from
that one `PeekedSnapshot`; the existing `exists` keeps its behavior. Test in
`freshell-sessions`:
`peek_with_freshness_pairs_snapshot_and_freshness_from_one_guard_read` —
publish snapshot generation 1, expire the TTL (injected/short TTL), publish
generation 2, hammer `peek_with_freshness` concurrently with re-publishes,
and assert every returned `PeekedSnapshot` with `fresh: true` carries the
generation that was fresh at its own read (never a stale generation's items
paired with another generation's freshness).

**Deferred re-authorization (Slice F5):** a launched-but-unconfirmed legacy
candidate (`Unknown` or stale-`Absent`) is recorded as an unconfirmed
marker `{candidate, terminal_id, create_request_id}` owned by the sink.
**Trigger (FE7 — specified exactly):** no refresh-completion subscription
API exists today and this plan does not add one. The F5 worker instead runs
a **bounded fresh-answer requery schedule** per marker: requery
`exists_with_freshness` with capped exponential backoff (1s, 2s, 4s, … cap
30s, at most 8 attempts) — each `exists` call itself kicks the detached
refresh (`existence.rs` module doc), which is what makes the schedule
converge — and stop early on the first **conclusive** fresh answer.
Dispositions, exhaustively (FE-R2-6):
fresh `Present` → publish through the discovered pipeline
(`publish_running_session_identity` + sink persist/announce) with provenance
`ExistenceValidatedLegacyResume`; fresh `Absent` → drop the marker
permanently with a structured warning; fresh **`Unknown`** → **continue the
bounded requery** — `Unknown` is non-final regardless of freshness (it is
reachable even from a warm, fresh index: the OpenCode by-id DB fallback
answers `Unreadable → Unknown` inside the warm-snapshot arm,
`crates/freshell-server/src/existence.rs:268-270`, e.g. under WAL lock
contention); `ProviderUnavailable` → drop permanently with a structured
warning (FE7). Attempts exhausted without a conclusive fresh answer —
including exhaustion on repeated fresh `Unknown`s — → drop with a
structured warning (the client's re-present loop is the remaining manual
path). Markers are dropped on terminal exit. Fresh `Absent` or
`ProviderUnavailable` at create time is never deferred.

## Amplifier Probe-Before-Stub (LB15)

For amplifier `LegacyResume` candidates only: run existence authorization
using a **probe-only** lookup (never creates) **before** any
`ensure_session` stub write. Only `ServerPreallocated` (this request minted
the UUID), `AcceptedSessionRef`, and `ExistenceValidatedLegacyResume`
outcomes may create or re-stub. The stub write itself stays **before**
`registry.create` — the events-lane resolver attaches at create time and that
ordering is load-bearing. Additionally, when adjudicating **legacy**
candidates, the existence decision ignores zero-turn broker-shaped stubs
(no `turn_count`, `freshell_terminal_id` present) so a leftover stub from a
crashed prior create — or Freshell's own just-written stub — cannot
self-authorize a caller-provided id. Implementation should check
`amplifier_stub.rs` for an existing non-creating lookup before adding one.

## Callback Contract and Lock Order (LB3, FE1)

The synchronous publication callback runs while `RegistryInner`'s
`std::sync::Mutex` is held, and every other registry operation acquires that
mutex with `.lock().expect(...)`. An unwinding callback would therefore
poison the mutex **after** the `PtyTerminal` is inserted: every later
registry call panics and the PTY is stranded with no kill or attach path.
The previous revision's "permit the panic and test with `catch_unwind`"
stance is deleted. The contract is **panic-free by construction, enforced by
an abort-on-panic wrapper** — document it on the trait and test the final
adapter:

- The callback body is exactly one leaf in-memory write
  (`upsert_with_retirement` — a `RwLock`-guarded map insert). It does no
  broadcast, no ledger I/O, no runtime probing, no await, no
  terminal-registry re-entry, and no fallible work beyond cloning the row
  fields.
- The registry invokes **every** publication callback (create, running
  transition, retired transition) through an abort-on-panic guard: a drop
  bomb armed before the call and disarmed on normal return, whose
  unwind-path drop calls `std::process::abort()`. An unwind out of the
  callback is a fatal invariant violation; the process aborts **instead of**
  poisoning the registry.
- Rationale (document it on the wrapper): a poisoned registry strands every
  running PTY with no kill path while the server limps on; an abort closes
  every PTY master fd, delivering SIGHUP/EIO to the child process groups,
  and lets supervision restart cleanly. Abort is strictly the safer failure.
- Tests (Slice B): a **subprocess-based abort test** (re-exec the current
  test binary with an env var arming a panicking publisher; assert the child
  terminates abnormally via abort, not via an ordinary unwinding panic or a
  poisoned-mutex panic) plus non-panic error-path tests proving registry
  usability and row rollback for every *reachable* failure — duplicate
  terminal id and publish refusals are error returns, never unwinds.
- `upsert_with_retirement` remains a leaf write-lock operation on the
  identity registry.
- No identity-registry method calls terminal-registry code while retaining an
  identity guard.
- Registry inner/terminal locks are taken strictly before the admission lock,
  never nested inversely (`registry.rs:1947-1951` discipline survives the
  extraction).

## Lifecycle Corrections (G1)

- **Pre-spawn ledger writes: exactly one bounded exception (LB5 + FE3).**
  The previous revision's *general* guarded pre-spawn `record_binding` stays
  deleted: an ordinary pre-spawn `Bound` row for a resume create is exposed
  by recovery inventory as `ledgerOnly` (`recovery_inventory.rs:254-265`),
  opening a competing-recovery window, and G1's prepared-state machinery is
  not needed. However, production already ships — and #584 extended to the
  REST door — the **PIN2 fresh-Claude minted-id pre-spawn binding** (WS
  `terminal.rs:2198` `PIN2_CLAUDE_PRE_SPAWN_BINDING` with its spawn-failure
  delete twin at `:2277`; REST twin gated on `claude_fresh_prealloc` only;
  pinned by the `rest_claude_identity.rs` durability e2e). This lane is
  **kept, not migrated away**: the id is minted by this create, so no
  competing writer and no meaningful competing-recovery offer can exist
  before the spawn (the UUID is unknown to every other actor), and the
  crash-before-spawn residue is one inert `Bound` row for a session that was
  never created — resuming it fails loudly; it is not a two-writer shape.
  LB5's rule is therefore rescoped: **no pre-spawn ledger write may exist
  except the PIN2 minted-fresh-Claude lane**, and none may be added for
  resumes, other providers, or discovered ids. The sink absorbs the two
  binder pre-spawn methods behind typed trait methods (Slice D) so the
  exception stays visible and testable. All other spawn failures write
  nothing and release the admission lease via RAII.
- **Settlement-owner-held finalization guard (LB6, FE9) with the two-phase
  settle handoff (FE-R2-9).**
  `create_with_publication` returns a `CreateFinalizationGuard`. The wrapped
  exit hook waits on it; the **settlement owner** holds it through provider
  settlement, the awaited durable write, and the announcement enqueue, then
  drops it. Drop (any path, including unwind) opens the gate. On the REST
  door the settlement owner is the **detached settle task** — the guard
  lives inside that task's scope and is never returned to the HTTP handler
  future, so a client abort (which drops only the handler future) cannot
  open the gate early or skip bookkeeping; a cancellation test proves it
  (Slice E2). **The announcement-ordering conflict is resolved explicitly
  (FE-R2-9, redesigned per FE-R3-8):** the route builds `ui.command` and
  completes its pane/tab bookkeeping only after it learns the spawn result,
  yet the settle task must hold the guard through announcement and Slice H
  forbids the lower helper announcing before caller bookkeeping. Revision
  3's shape was **circular** — verified against current code:
  `spawn_terminal_pane` awaits `settle_gated_create`'s `JoinHandle`
  (`terminal_tabs.rs:1144-1165`: `let settle = tokio::spawn(…);
  match settle.await`) and `create_terminal_tab` builds the `ui.command`
  payload only after `spawn_terminal_pane` returns
  (`terminal_tabs.rs:1902-1950`), so a settle task that waits for the
  route's closure before finishing deadlocks against a route waiting for
  the `JoinHandle`. Design — the **two-phase settle handoff with a
  phase-one result channel**:
  - **Channels** (all `tokio::sync::oneshot`, created by the route before
    spawning the settle task):
    `result_tx: Sender<Result<TerminalSpawnResult, Response>>` (settle →
    route), `announce_tx: Sender<AnnouncementPlan>` (route → settle), and
    `ack_tx: Sender<AnnounceOutcome>` (settle → route, where
    `AnnounceOutcome ∈ {Announced, RetiredDuringSettlement}`).
  - **Phase 1 (settle):** the detached settle task runs spawn + provider
    settlement + identity publication + the awaited durable write, then
    sends the creation result over `result_tx` **without finishing** —
    the task lives on, still holding the finalization guard and the
    permit — and awaits `announce_rx`. A spawn/settlement failure sends
    `Err(response)` and finishes (RAII releases guard/permit/lease as
    today).
  - **Phase 2 (announce):** `spawn_terminal_pane` returns the phase-one
    result plus the `{announce_tx, ack_rx}` handle to its caller; the
    route (`create_terminal_tab` / split / respawn), after its pane/tab
    bookkeeping and `ui.command` construction, sends its
    `AnnouncementPlan` (prebuilt frames: ordinary
    `ui.command -> terminals.changed -> terminal.meta.updated`, or the
    deferred no-`ui.command` shape) and awaits the ack before building
    the HTTP response — preserving the enqueue-before-return claim. The
    settle task, on receiving the plan, **re-checks under the registry
    that the row is still present and Running (FE-R3-10 — see the
    kill-during-settlement rule below)**, enqueues the frames in order,
    sends the ack, and only then drops the guard and finishes.
  - **Cancellation and failure (deterministic, no timeouts anywhere):**
    the route never awaits the settle `JoinHandle` mid-phase. If the
    settle task panics before its phase-one send, `result_tx` drops and
    the route maps the `RecvError` to the 500 the `JoinError` arm returns
    today. If the HTTP handler future is dropped at any point after
    spawn (client abort), `announce_tx` drops; the settle task observes
    the closed channel deterministically and runs the fallback
    **deferred-shape announcement** (`terminals.changed ->
    terminal.meta.updated`, no `ui.command`, same Running re-check), then
    drops the guard and finishes — settlement and gate release always
    complete (FE9). A failed phase-one send (route already gone) takes
    the same fallback path. Ack-send failure after a late abort is
    ignored.
  Exit cleanup can therefore never resurrect a row after
  retirement, delete a pending marker before it is written, or announce a
  retired terminal as created.
- **Kill-during-settlement re-check (FE-R3-10).** `registry.kill`
  (`kill_internal`, `registry.rs:1444-1503`) **removes the row and marks it
  exited before dropping the PTY**, and the finalization gate blocks only
  the PTY reader's exit hook — a WS `terminal.kill` landing mid-settlement
  is not blocked by the guard. The settle task therefore re-checks, under
  the registry and immediately before enqueueing, that the row is still
  present and Running. On failure it skips the `Created`/`ui.command`
  shape entirely, enqueues `terminals.changed` only (the kill already
  bumped the revision), runs the epoch-conditional persistence cleanup
  (`delete_pending_if_owned` with its own epoch; the ledger `Closed`
  retirement stays `handle_kill`'s own awaited job), sends
  `AnnounceOutcome::RetiredDuringSettlement`, and drops the guard. The
  barrier test `kill_during_settlement_skips_created_and_cleans_up_epoch_conditionally`
  (Slice E2) holds the settle task between publication and announcement,
  kills the terminal, releases, and asserts no `Created`/`ui.command`
  frame and the cleanup ran.
- **Gate opens on every error path (LB4, FE1) — duplicate ids rejected by
  pre-reservation, before any PTY exists (FE-R3-9).** Rejecting a duplicate
  id *after* spawning is unsafe even without dropping anything under the
  lock: a `PtyTerminal` dropped without insertion kills its child
  (`impl Drop for PtyTerminal`, `crates/freshell-terminal/src/pty.rs:440-451`),
  its reader then EOFs and invokes the ID-keyed exit hook
  (`pty.rs:507-515`), and once the finalization gate opens that hook would
  `finish_pty_exit` the **pre-existing** row that legitimately owns the id.
  Therefore `create_with_publication` **pre-reserves the terminal id under
  `RegistryInner` before spawning**: an id already present as a row or as a
  live reservation is rejected with an error return at reservation time —
  no PTY is ever created for a duplicate, so no orphan hook can exist. The
  reservation is replaced by the row on success and dropped on every
  failure path (spawn error, publish refusal, unwind). The guard is created
  immediately after successful PTY creation, before registry insertion, and
  its drop opens the gate on every return path. Publisher panics are
  **not** a gate path: they abort the process (Callback Contract). Tests
  cover the duplicate-rejection path (pre-existing terminal stays Running,
  zero spawns for the loser), the reservation-cleanup path, the
  spawn-failure path, and the subprocess abort test.
- **Exit-cause model (LB7).**

  ```rust
  #[derive(Debug, Clone, Copy, PartialEq, Eq)]
  pub enum TerminalExitCause { NaturalExit, ExplicitClose }
  ```

  `retire_terminal_identity(terminal_id, cause)`: both causes mark the
  in-memory identity retired (retained) **and both causes run the
  epoch-guarded pending-marker delete (`delete_pending_if_owned`) — pending
  cleanup happens on every exit (FE-R2-7: the landed binder's natural-exit
  hook already deletes pending markers, pinned by
  `retire_pane_identity_retires_row_and_clears_pending`,
  `pane_identity_binder.rs:267-310`; that behavior is current production
  truth and is preserved through the migration).** Only `ExplicitClose`
  additionally runs `retire_closed_if_owned` on the ledger. Natural exit,
  successful and exhausted auto-resume, and graceful shutdown leave rows
  `Bound` (`auto_resume.rs` doc: a still-Bound row is the not-closed signal;
  `retire_closed`'s single production call site today is `handle_kill`,
  `ws/terminal.rs:3880/3895` — that discipline is preserved and **stays
  WS-only**). **Explicit-close persistence stays awaited (FE-R2-8):**
  today's `handle_kill` awaits the `spawn_blocking` ledger retirement before
  completing (`ws/terminal.rs:3880-3903`); the sink must not weaken that to
  fire-and-forget, or a kill response followed by a crash could leave a
  `Bound` row. `retire_terminal_identity` therefore returns an awaitable
  `TerminalRetirementCompletion` (see Slice D) that resolves when the
  ledger cleanup job settles; `handle_kill` awaits it. **FE8: there is no
  REST close door.** Pane/tab DELETEs keep
  PTYs for reattach and `DELETE /api/terminals/:id` only hides
  (`terminals.rs:1033-1050`), so no REST code path may pass `ExplicitClose`;
  a REST kill route is explicitly out of scope. Graceful shutdown calls no
  new retirement.
- **Epoch-conditional cleanup (LB8).** `retire_closed_if_owned(provider,
  session_id, terminal_id, create_request_id)` and epoch-keyed pending
  markers with `delete_pending_if_owned`. Comparison and mutation happen
  under the ledger's serialization guard. A delayed old cleanup returns
  `NotOwned` against a replacement owner, proven by a barrier test.
- **Retired OpenCode missing-row lane (LB9).** Explicit `registry.kill`
  removes the terminal row (`registry.rs:1381-1406`); the retained OpenCode
  signal may still rebind afterwards. `publish_retired_signal_identity`
  therefore permits an **absent** registry row when the retained retired
  identity and the exact previous-session CAS match: it updates the identity
  registry (retired) and the ledger without fabricating a live registry row
  and without calling `registry.set_meta`. The established kill/removal
  contract and `tui_switch_signal_rebinds_and_restart_resumes_the_new_id`
  stay green.
- **Weak ownership (LB1).** The `FreshAgentOwnerProbe` closures capture
  `Weak` projections of the fresh-agent states (upgrade per call, answer
  `false` on failure); the states keep their existing
  `Arc<OnceLock<Arc<dyn PaneIdentitySink>>>`. This breaks the
  sink → probe → state → OnceLock → sink strong cycle. A teardown test
  constructs the full boot graph, drops the external handles, and proves the
  sink and states deallocate (Weak upgrades fail / strong counts reach zero).

## Sink Placement and Boot Wiring (LB18, LB2)

- The production `LedgerIdentitySink` moves from bin-only
  `crates/freshell-server/src/identity_sink.rs` into a new
  `crates/freshell-ws/src/identity_sink.rs`. #584 independently proved this
  placement: its production write impl `LedgerPaneIdentityBinder` already
  lives in `crates/freshell-ws/src/pane_identity_binder.rs`, and the new
  sink absorbs its logic (the binder module is deleted in Slice E2).
  Verified feasible with no cycle:
  `freshell-ws` already depends on `freshell-freshagent` (owner of
  `PaneIdentitySink`) and already owns `PaneLedger`,
  `TerminalIdentityRegistry`, and the `SharedExistenceProbe` trait
  (`ws/existence.rs:39,104`); the index-backed probe impl and the owner-probe
  closure stay server-owned and injected. The sink must gain no server-only
  dependency. `crates/freshell-server/src/identity_sink.rs` shrinks to
  construction glue plus its unit-test harness.
- **Five consumers, all asserted at boot** (`main.rs`): `FreshAgentState`,
  `FreshClaudeState`, `FreshCodexState`, `FreshOpencodeState`, and `WsState`
  each expose `identity_sink_wired()` plus an assertion accessor; boot
  asserts all five wired **and** `Arc::ptr_eq` against the one constructed
  sink. Production wiring surfaces a discarded `OnceLock::set` failure
  loudly — FE-R2-10: `OnceLock::set(...).expect(...)` does **not** compile
  here (the `Err(Arc<dyn PaneIdentitySink>)` payload is not `Debug`), so the
  boot path uses
  `assert!(cell.set(sink).is_ok(), "identity sink wired twice")` (or the
  setters return `bool` and boot asserts each); the
  four current setters' silent `let _ =` (`lib.rs:292-294`,
  `claude.rs:189-191`, `codex.rs:318-320`, `opencode_ws.rs:234-236`) must
  not remain the only guard. The sink owns the shared `terminals_revision`
  increment and announcement dedupe, so a forked sink instance would fork
  the revision stream — exactly the split-publication class this plan kills.

## Publication and Event Ordering

```text
known create (REST or WS, negotiated):
  admission claim (atomic, cross-kind)            [Slice B0]
  -> derive candidate + authorize
     (live-owner checks -> existence mapping)     [Slices A, D, E2]
  -> [amplifier legacy: probe-only existence BEFORE stub; then stub]
  -> [fresh claude minted id only: awaited PIN2 pre-spawn binding
      (kept; the one LB5 exception — deleted again on spawn failure)]
  -> spawn PTY; finalization guard created
  -> registry row insert + identity upsert (one registry critical section)
  -> provider-specific settle/adoption/admission complete(BoundOwner)
  -> awaited post-spawn durable binding (spawn_blocking)
  -> announcement enqueue:
       ordinary: ui.command -> terminals.changed -> terminal.meta.updated
       deferred: terminals.changed -> terminal.meta.updated
                 (ui command returned in the HTTP body, not broadcast)
  -> finalization guard dropped (exit hook may now run)
  -> HTTP/WS completion (frames already enqueued)

post-launch discovery (fresh codex/opencode; deferred legacy re-auth):
  provider locator / requery returns id
  -> claim_discovered(claimant, prior token) (atomic; any different owner
     or poisoned key -> refusal + deduped conflict hold + invariant ERROR +
     session.collision.detected frame, D3-clarified; process left running;
     hold handle stored on the row — FE-R3-4c)
  -> authorize (live-owner first, self-exempting the candidate's own row —
     FE-R3-6)
  -> registry running-row identity transition + identity upsert
     (one registry critical section)
  -> on success: store the minted BoundOwner on the row's admission record
     (FE-R3-4b); on any rejection or publish failure after a fresh Bound:
     clear_binding_if_owner(minted token) rollback (FE-R3-4a; an
     AlreadyBoundToCaller answer is never rolled back — the binding
     predates this call)
  -> awaited durable binding, then epoch-guarded pending delete
  -> terminal.session.associated -> terminals.changed -> terminal.meta.updated

live rebind (codex fork; claude/opencode signal A -> B switch):
  rebind_discovered(old token for A, new sid B) (atomic: A released
  epoch-conditionally + B claimed in one lock scope — FE-R3-5)
  -> shared discovered pipeline as above; caller stores the new token

exit:
  finalization guard wait (create settlement completes first)
  -> finish_pty_exit
  -> retire_terminal_identity(terminal_id, cause) -> completion:
       memory identity marked retired (retained)
       expected values resolved from the sink's publication-time
         ownership record, never from live state (FE-R3-11)
       every cause: epoch-guarded pending delete (FE-R2-7)
       ExplicitClose only: retire_closed_if_owned
         (handle_kill AWAITS the returned completion — FE-R2-8)
       NaturalExit: no ledger Closed retirement (rows stay Bound;
         auto-resume intact; completion may be dropped)
       ownership record removed when the cleanup job settles
  -> admission clear_binding_if_owner(stored BoundOwner token) (FE-R2-1)
     + release_conflict_hold(stored ConflictHoldHandle) if this process
       was a refused loser (FE-R2-2/FE-R3-3)
  -> provider-specific locator/sidecar/stub cleanup
```

All "before the HTTP response" claims are enqueue claims (see Global
Constraints). Handshake-inventory resync is the recovery invariant for missed
frames.

## File Map

- Create `crates/freshell-terminal/src/session_admission.rs`: shared
  cross-kind admission table.
- Modify `crates/freshell-terminal/src/registry.rs`: D8 facade over
  `SessionAdmission`; `create_with_publication` + finalization guard +
  abort-on-panic publication wrapper; atomic running/retired identity
  transitions; **terminal-id pre-reservation before PTY spawn (FE-R3-9)**;
  row-stored admission token / conflict-hold handle
  (`store_admission_token`/`store_conflict_hold`, FE-R3-4); **remove the
  `PaneIdentityBinder` trait** once its call sites migrate (Slice E2).
- Modify `crates/freshell-terminal/src/lib.rs`: export the admission module.
- Modify `crates/freshell-freshagent/src/session_lease.rs`:
  `FreshAgentSessionLeases` becomes a facade over the shared table.
- Modify `crates/freshell-freshagent/src/identity_sink.rs`: provenance types,
  pure classifier (four providers only), trait extension, extended
  `FakeIdentitySink`.
- Modify `crates/freshell-freshagent/src/lib.rs`: re-exports; loud sink
  wiring; `identity_sink_wired()`; **remove `with_pane_identity_binder` and
  the `pane_identity` field** when the binder is absorbed (Slice E2).
- Modify `crates/freshell-freshagent/src/terminal_tabs.rs`: provenance-aware
  derivation, fresh Claude mint, admission claim on the legacy rung **and
  ahead of the amplifier `ensure_session` block (FE-R3-12)**,
  probe-before-stub ordering, known-identity create publication, pending
  publication, cause-aware retirement, ordered REST announcement via the
  **phase-one result channel handoff (FE-R3-8)** with the
  kill-during-settlement re-check (FE-R3-10), scoped pane promotion.
- Modify `crates/freshell-freshagent/src/{claude,codex,opencode_ws}.rs`: loud
  sink setters/getters for boot assertions (Slice D); lease cleanup call
  sites migrate to the epoch-token `clear_binding_if_owner` form (Slice B0,
  FE-R2-1 — `claude.rs:1218`, `codex.rs:1245/3287/3295`,
  `opencode_ws.rs:791`).
- Create `crates/freshell-ws/src/identity_sink.rs`: the production
  `LedgerIdentitySink` (moved per LB18; absorbs `LedgerPaneIdentityBinder`'s
  write logic and ported unit tests) with authorization ordering
  (self-exempting live-owner join, FE-R3-6), exit-cause retirement driven by
  the **publication-time ownership record (FE-R3-11)**, deferred-marker
  storage, announcement/revision ownership, and the `null_sink_for_tests()`
  helper (FE5).
- Delete `crates/freshell-ws/src/pane_identity_binder.rs` (Slice E2, after
  its call sites and tests migrate into the sink).
- Modify `crates/freshell-ws/src/auto_resume.rs`: `claim_session` gains the
  `SessionRefClaim::OwnedByFreshAgent` refusal arm (FE4, Slice B0).
- Create `crates/freshell-ws/src/terminal_identity_publication.rs`:
  `publish_discovered_terminal_identity` / `publish_retired_signal_identity`
  helpers and the deferred re-authorization worker.
- Modify `crates/freshell-ws/src/lib.rs`: `WsState` carries the sink;
  `identity_sink_wired()`. FE5: every `WsState` struct literal in the
  workspace (~38 sites, enumerated in Slice D) is updated in the same slice.
- Modify `crates/freshell-ws/src/identity.rs`: `upsert_with_retirement`
  (leaf single-write-lock).
- Modify `crates/freshell-ws/src/pane_ledger.rs` (+ `pane_ledger_tests.rs`):
  `retire_closed_if_owned`, epoch-keyed pending markers,
  `delete_pending_if_owned`.
- Modify `crates/freshell-ws/src/terminal.rs`: D5 legacy session-carrying
  create rejection + legacy-path removal; admission-mapped claim answers;
  WS known-create migration; cause-aware retirement in `handle_kill` and the
  natural-exit hook.
- Modify `crates/freshell-ws/src/opencode_association.rs`,
  `crates/freshell-ws/src/codex_association.rs` (NOT `codex_identity.rs` —
  the migrated write tail and its tests live in `codex_association.rs`;
  `codex_identity.rs` keeps its adoption guards, now routed through
  `claim_discovered`), `crates/freshell-ws/src/opencode_signal.rs`,
  `crates/freshell-ws/src/claude_signal.rs`: shared publication migration.
- Modify `crates/freshell-ws/src/reconcile.rs`: scope the promoted-claim echo
  to gemini/kimi; four providers read published identity only.
- Modify `crates/freshell-server/src/identity_sink.rs`: shrink to
  construction glue; keep the bin unit-test harness (boot wiring/teardown
  tests; the gf_ui incident pin lives in the Slice I integration suite).
- Modify `crates/freshell-server/src/main.rs`: one `SessionAdmission`, one
  sink, five-consumer injection, wired + `Arc::ptr_eq` boot assertions, weak
  owner probes.
- Modify `crates/freshell-server/src/terminals.rs`: authority-only projection
  for the four providers; gemini/kimi synthesis retained.
- Modify `crates/freshell-server/src/existence.rs`: `exists_with_freshness`
  impl (FE6); probe-only / legacy-adjudication variant that ignores
  zero-turn broker-shaped stubs (trait extension in
  `crates/freshell-ws/src/existence.rs`).
- Modify `crates/freshell-sessions/src/directory_index.rs`: atomic
  `peek_with_freshness()` (one-lock snapshot + freshness + generation,
  FE-R2-5) that `exists_with_freshness` consumes.
- `crates/freshell-platform/src/cli_launch.rs`: **no change** — the shared
  fresh-Claude preallocation predicate landed in #584 (Slice E1 is
  verify-only).
- Create `crates/freshell-ws/tests/cross_kind_admission.rs`:
  barrier-synchronized cross-kind exactly-one-winner suite (extends the
  harness patterns of `cross_kind_liveness.rs`,
  `freshagent_session_lease.rs`, `rest_ws_shared_gate.rs`).
- Create `crates/freshell-ws/tests/rest_terminal_identity.rs`: merged
  REST/WS/provider-matrix integration suite importing the **production**
  sink, including the exact `gf ui` incident.
- Modify `test/unit/client/components/App.ws-bootstrap.test.tsx`: exact stale
  directory-row convergence regression + adverse-interleaving test.
- Create `test/e2e-browser/specs/rest-terminal-identity-rust.spec.ts`:
  scratch-server browser proof.
- Modify `test/e2e-browser/playwright.config.ts`: register the new
  Rust-only spec in **both** the `rust-chromium` `testMatch` allowlist and
  the `RUST_ONLY_SPECS` exclusion list (FE-R2-13).
- Modify `test/integration/real/coding-cli-session-contract.test.ts`:
  version-gated OpenCode contract.
- Modify `crates/freshell-protocol/src/server_messages.rs`: add
  `session.collision.detected` to `EXTENSION_SERVER_MESSAGE_TYPES`
  (extension lane, `server_messages.rs:211-221` precedent — no generated
  inventory drift; FE-R3-1), with a Rust shape-pin test.
- Modify `src/lib/terminal-invalidation-handler.ts` and create
  `src/components/SessionCollisionBanner.tsx`: client alarm surface for
  `session.collision.detected` (FE-R3-1; banner precedent
  `ReconcileWarmingBanner.tsx`); test in
  `test/unit/client/lib/terminal-invalidation-handler.test.ts`.
- Do not modify `src/store/selectors/sidebarSelectors.ts`.

## Reconciliation with Merged PR #584 (landed at `6147c700`; base now `c5e9fdaa`)

PR #584 (`fix/rest-terminal-session-identity`, kata `hbsa`) and PR #583
merged into `origin/main` while the previous revision was being written; the
old "harvest the Claude-focused branch" guidance is obsolete. PR #585 then
moved main to `c5e9fdaa` with deck visual work only (crate-empty diff —
FE-R2-4, see Global Constraints). This section is
the authoritative delta. Implementers must study
`git log --stat 537d7d09..c5e9fdaa` before starting.

**Landed — verify, do not redo:**

- **Slice E1 is DONE.** `freshell_platform::should_preallocate_fresh_claude`
  plus its truth table (`crates/freshell-platform/src/cli_launch.rs:601-726`),
  already consumed by both doors.
- **REST fresh-Claude minting is DONE** (`4d46c86a`): REST claude creates
  mint a preallocated `--session-id` with `LaunchIntent::Start`;
  `derive_resume_identity` already returns the pre-provider-filter parse
  result; `claude_fresh_prealloc` flows through `GatedSettleInputs`; split
  and respawn mint pins landed in `terminal_tabs.rs` tests.
- **The exact `gf ui` incident is FIXED** (`1bc31c5f` + pins in
  `crates/freshell-ws/tests/rest_locator_identity.rs` and
  `rest_claude_identity.rs`). See the incident section; it becomes a green
  pin in Slice I.
- **PIN2 pre-spawn Claude binding on the REST door** (awaited,
  `spawn_blocking`, `claude_fresh_prealloc`-gated, with the spawn-failure
  delete) — kept per the LB5 rescope in Lifecycle Corrections.

**Landed — absorb and migrate (FE3):**

- `PaneIdentityBinder`: trait at
  `crates/freshell-terminal/src/registry.rs:655-703`, production impl
  `LedgerPaneIdentityBinder` at
  `crates/freshell-ws/src/pane_identity_binder.rs`, wiring via
  `FreshAgentState::with_pane_identity_binder` (`freshagent/lib.rs:475`) and
  `main.rs:305`. Its crate placement independently confirms LB18. It is,
  however, a second, **provenance-blind** write seam:
  `register_create_identity` publishes an identity row and ledger binding
  for *any* session-carrying create — including unvalidated legacy raw ids —
  which conflicts with this plan's authority model (a raw id becomes
  authoritative only on `Present` existence). Migration (Slice E2, after the
  sink exists in Slice D): move each of the four binder call sites
  (`record_prespawn_claude_binding`, `delete_prespawn_claude_binding`,
  `register_create_identity`, `retire_pane_identity`) onto the extended
  `PaneIdentitySink` — the pre-spawn pair as the typed PIN2 exception; the
  post-spawn write through candidate → authorize → publish → persist; the
  exit hook through `retire_terminal_identity(id, NaturalExit)` (the
  binder's natural-exit-leaves-`Bound` behavior already matches LB7). Port
  the binder's unit tests into the ws `identity_sink::tests` module — they
  pin load-bearing behavior (natural exit leaves the ledger `Bound`, write
  failure never blocks a create, pending markers for `MARKER_MODES`, shell
  no-op). Then delete `pane_identity_binder.rs`, the trait, and the
  `with_pane_identity_binder` wiring in the same slice. The landed
  integration pins must stay green through the migration — **except** where
  this plan deliberately changes behavior (legacy raw ids no longer publish
  without existence validation): if a landed pin asserts raw-id publication,
  rescope it to an accepted-ref or `Present`-existence fixture and record
  the delta in the implementation report.
- The binder's warn-and-proceed failure policy maps onto this plan's typed
  `Degraded` durability plus exactly one `durability.degraded` frame.

**Landed — narrows a hole but does not close it:**

- The A13 e2e pins refuse fresh-agent/signal claims on sessions owned by
  live REST terminals — possible now that REST creates publish identity
  rows. The REST **terminal** door still claims nothing cross-kind
  (`terminal_tabs.rs` has no `has_live_session` reference on `6147c700`),
  and #584's own plan records its LB-11 residual cross-kind race as out of
  scope. Slice B0 (D4) remains fully necessary.

**Superseded planning artifacts:**

- Main's `docs/superpowers/plans/2026-07-29-rest-terminal-session-identity.md`
  is #584's historical plan document. Do not edit it and do not re-implement
  its tasks; everything still relevant from it is subsumed here.

---

# Implementation Slices

Design rules for every slice: (a) every RED is a runtime assertion failure —
the slice lands a compiling minimal stub together with its tests; (b) no
commit contains a red test; (c) no slice leaves any Cargo target uncompilable
at its commit boundary; (d) trait growth never breaks a downstream implementer
across a slice boundary (defaults flipped to required within one slice);
(e) every focused command names a real crate/target and is not blocked by an
earlier slice; (f) **no vacuous greens (FE-R2-11):** every focused test
command must demonstrably select at least one test — `--exact` filters use
the **fully qualified module path** (e.g.
`cli_launch::tests::fresh_claude_preallocation_predicate_truth_table`, never
the bare function name), and the runner must verify the harness summary
shows the expected nonzero count (e.g. `1 passed`) — a `running 0 tests` /
`0 passed; 0 failed` result is a command bug, treat it as RED.

- [ ] **Preflight (before Slice A):** confirm branch/base per the Global
  Constraints baseline gate — fetch and verify the branch sits atop
  **current `origin/main`** (`c5e9fdaa` as of this revision; if main moved,
  rebase and verify `git diff c5e9fdaa..origin/main -- crates` is empty or
  re-validate affected facts first — FE-R2-4). Confirm the landed E1
  predicate with the fully qualified name (FE-R2-11):

```bash
cargo test -p freshell-platform cli_launch::tests::fresh_claude_preallocation_predicate_truth_table -- --exact --nocapture
```

  Verify the summary reports `1 passed` (a `running 0 tests` output means
  the filter is wrong — treat as RED). Study
  `git log --stat 537d7d09..c5e9fdaa` (Reconciliation section), then
  run the repo-supported baseline on this base via the shared test
  coordinator per `AGENTS.md`. Record counts in the implementation report.
  Stop on a red base.

---

### Slice A — Provenance types + pure classifier

**Files:** `crates/freshell-freshagent/src/identity_sink.rs`,
`crates/freshell-freshagent/src/lib.rs` (re-exports).

**Interfaces:** the full type family, exactly:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalIdentityCandidateSource {
    AcceptedSessionRef,
    ServerPreallocated,
    ProviderDiscovered,
    LegacyResume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalIdentityProvenance {
    AcceptedSessionRef,
    ServerPreallocated,
    ProviderDiscovered,
    ExistenceValidatedLegacyResume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalIdentityVisibility { Live, Retired }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalExitCause { NaturalExit, ExplicitClose }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalIdentityCandidate {
    pub provider: String,
    pub session_id: String,
    pub terminal_id: String,
    pub mode: String,
    pub cwd: Option<String>,
    pub create_request_id: Option<String>,
    pub updated_at: i64,
    pub source: TerminalIdentityCandidateSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizedTerminalIdentity {
    pub provider: String,
    pub session_id: String,
    pub terminal_id: String,
    pub mode: String,
    pub cwd: Option<String>,
    pub create_request_id: Option<String>,
    pub updated_at: i64,
    pub provenance: TerminalIdentityProvenance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalIdentityRejection {
    LiveFreshAgentOwner,
    LegacyIdentityAbsent,        // permanent (fresh-index miss)
    LegacyIdentityUnconfirmed,   // deferrable (cold/stale index)
    ProviderUnavailable,         // permanent (missing provider root — FE7/FE-R2-15)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalIdentityAuthorization {
    Publish(AuthorizedTerminalIdentity),
    Reject(TerminalIdentityRejection),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalDurabilityPhase { Prespawn, Postspawn, Discovery, Pending, Cleanup }
// `Prespawn` exists solely for the PIN2 minted-fresh-Claude lane (LB5
// rescope, FE3) so its typed degradation is machine-distinct.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalDurabilityDegradation {
    LedgerUnavailable,
    WriteFailed { message: String },
    BlockingTaskFailed { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalIdentityDurability {
    Durable,
    Degraded { phase: TerminalDurabilityPhase, reason: TerminalDurabilityDegradation },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalPendingIdentity {
    pub terminal_id: String,
    pub mode: String,
    pub cwd: Option<String>,
    pub create_request_id: Option<String>, // pending markers are epoch-keyed (LB8)
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalIdentityAnnouncement {
    Created {
        identity: Option<AuthorizedTerminalIdentity>,
        durability: Option<TerminalIdentityDurability>,
    },
    Associated {
        identity: AuthorizedTerminalIdentity,
        previous_session_id: Option<String>,
        durability: TerminalIdentityDurability,
    },
}

// Boxed-future aliases used by the Slice D trait methods (existing style):
pub type TerminalAuthorization = Pin<
    Box<dyn Future<Output = TerminalIdentityAuthorization> + Send + 'static>
>;
pub type TerminalDurabilityWrite = Pin<
    Box<dyn Future<Output = TerminalIdentityDurability> + Send + 'static>
>;

pub fn classify_terminal_identity_candidate(
    mode: &str,
    accepted_session_ref: Option<(&str, &str)>,
    legacy_resume_session_id: Option<&str>,
) -> Option<TerminalIdentityCandidateSource>
```

Classifier policy (four providers only, per D1): returns
`AcceptedSessionRef` only when the ref provider equals `mode` and `mode` is
one of `claude|codex|opencode|amplifier`; without a parsed ref it returns
`LegacyResume` for a nonempty raw resume id **only for those four modes**;
`gemini`, `kimi`, `shell`, and every other mode return `None` (documented D1
carve-out — gemini/kimi keep their legacy synthesis path untouched).
Server-minted and provider-discovered sources are assigned only by their
provider-policy callers. (`SessionLocator` provider parsing is already
four-provider; the mode scoping is what protects the legacy arm.)

- [ ] **Step 1 (RED):** land the type family plus
  `classify_terminal_identity_candidate` stubbed to `None`, together with the
  table test `terminal_identity_candidate_requires_authoritative_provenance`
  in `identity_sink::tests` (next to the code — not in `terminal_tabs.rs`).
  Compare `Option<TerminalIdentityCandidateSource>` directly (the previous
  revision's `.map(|candidate| candidate.source)` could never compile —
  G5 §4.1):

```rust
use TerminalIdentityCandidateSource::{AcceptedSessionRef, LegacyResume};

let cases = [
    ("codex", Some(("codex", "c1")), None, Some(AcceptedSessionRef)),
    ("opencode", Some(("opencode", "ses_1")), None, Some(AcceptedSessionRef)),
    ("claude", Some(("claude", CLAUDE_ID)), None, Some(AcceptedSessionRef)),
    ("amplifier", Some(("amplifier", AMP_ID)), None, Some(AcceptedSessionRef)),
    ("codex", Some(("claude", CLAUDE_ID)), None, None),
    ("opencode", None, Some("ses_raw"), Some(LegacyResume)),
    ("claude", None, Some(CLAUDE_ID), Some(LegacyResume)),
    ("amplifier", None, Some(AMP_ID), Some(LegacyResume)),
    ("gemini", None, Some("g_raw"), None),   // D1 carve-out
    ("kimi", None, Some("k_raw"), None),     // D1 carve-out
    ("shell", None, None, None),
];

for (mode, session_ref, legacy, expected) in cases {
    assert_eq!(
        classify_terminal_identity_candidate(mode, session_ref, legacy),
        expected,
    );
}
```

  RED: the stub fails the seven non-`None` rows at runtime.

- [ ] **Step 2 (GREEN + refactor):** implement the policy; rerun.

```bash
cargo test -p freshell-freshagent identity_sink::tests -- --nocapture
cargo fmt --all --check
cargo clippy -p freshell-freshagent --all-targets -- -D warnings
```

- [ ] **Step 3 (Commit):**

```bash
git add crates/freshell-freshagent/src/identity_sink.rs crates/freshell-freshagent/src/lib.rs
git commit -m "feat(freshagent): terminal identity provenance types and pure classifier"
```

Types-only addition: no dependent crate breaks.

---

### Slice B0 — Shared cross-kind `SessionAdmission` + REST-door fix + legacy-WS removal

Placed before every publication slice per **D4**: this closes the live
two-writer corruption hole first. Implements the design in "Cross-Kind
Session Admission" above and **D5**.

**Files:** create `crates/freshell-terminal/src/session_admission.rs`; modify
`crates/freshell-terminal/src/{lib,registry}.rs`,
`crates/freshell-freshagent/src/session_lease.rs`,
`crates/freshell-freshagent/src/{claude,codex,opencode_ws}.rs` (FE-R2-1
epoch-token cleanup migration),
`crates/freshell-freshagent/src/terminal_tabs.rs`,
`crates/freshell-ws/src/terminal.rs`,
`crates/freshell-ws/src/auto_resume.rs` (FE4 — its `claim_session` has an
exhaustive `SessionRefClaim` match at `auto_resume.rs:651-681` that stops
compiling the moment the new variant lands, so it is handled in the same
step), `crates/freshell-server/src/main.rs`;
create `crates/freshell-ws/tests/cross_kind_admission.rs`.

- [ ] **Step 1 (B0.1 RED):** land `SessionAdmission` with `claim` stubbed to
  always return `Acquired`, `complete`/`claim_discovered`/`rebind_discovered`
  returning a fixed epoch-0 `Bound`, and
  `clear_binding_if_owner`/`release_conflict_hold` as recording no-ops,
  together with threadless unit pins in
  `session_admission::tests` (the `registry.rs:4655`-style staged-
  interleaving trick, no sleeps):

  - `claim_vs_claim_yields_exactly_one_acquired`
  - `claim_across_complete_answers_bound_live`
  - `cross_kind_bound_live_is_never_adoptable`
  - `held_exposes_holder_kind` (FE-R2-3: a lease held by a Terminal holder
    answers `Held{holder: Terminal{..}}` to a second claimant; a
    FreshAgent-held lease answers `Held{holder: FreshAgent}` — this is the
    field the per-door same-kind/cross-kind error mapping depends on)
  - `complete_mints_a_unique_monotone_epoch_per_binding` (FE-R2-1: two
    sequential bind/clear/rebind cycles on the same key yield distinct,
    increasing epochs)
  - `claim_discovered_vs_lease_is_atomic`
  - `claim_discovered_with_matching_prior_token_is_idempotent` (FE11 +
    FE-R3-2: the caller presents the `BoundOwner` its own earlier claim
    minted; equality is kind AND epoch → `AlreadyBoundToCaller`)
  - `claim_discovered_without_prior_token_never_adopts_a_live_binding`
    (FE-R3-2: `prior: None` against a present binding — even one whose
    `BoundOwnerKind` payload matches — is `Refused`, never idempotent)
  - `claim_discovered_any_different_owner_is_refused` (FE11: a second
    same-kind terminal owner and a cross-kind owner both refuse; the
    process-left-running + loud-surface halves are asserted at the door
    level in Step 6 and Slice F)
  - `refused_discovery_installs_conflict_hold_and_poisons_key` (FE-R2-2:
    after a refusal, a fresh claim on the key answers `Poisoned`, never
    `Acquired`)
  - `poisoned_answers_carry_holder_kinds` (FE-R3-7: the `Poisoned` answer
    lists every hold's `BoundOwnerKind`, the field the WS door's
    same-kind/cross-kind mapping reads)
  - `duplicate_conflict_hold_install_is_deduplicated_per_holder` (FE-R3-3:
    a locator re-fire for the same refused holder returns the existing
    handle — same `HoldEpoch`, hold count still 1)
  - `conflict_hold_release_requires_matching_hold_epoch` (FE-R3-3: a
    release presenting a stale/forged epoch is a no-op and the key stays
    poisoned; the exact stored handle frees it)
  - `poisoned_key_stays_closed_after_owner_exit_until_hold_released`
    (FE-R2-2: owner A bound; discovery for B refused → hold installed; A's
    binding cleared with its token; a new claim is still refused while B's
    hold lives; `release_conflict_hold(&B_handle)` → the next claim
    acquires)
  - `rebind_atomically_releases_old_key_and_binds_new_key` (FE-R3-5: after
    `rebind_discovered(A→B)`, a fresh claim on A acquires while a claim on
    B answers `BoundLive` with the NEW token; the returned token differs
    from the old one)
  - `rebind_refusal_still_frees_old_key_and_poisons_new_key` (FE-R3-5: B
    owned by another writer → `Refused`; A reopens; B is conflict-held)
  - `rebind_with_stale_old_token_never_releases_a_replacement_binding`
    (FE-R3-5 × FE-R2-1: A was rebound to a replacement owner; a rebind
    presenting the stale A token leaves the replacement binding intact and
    only performs the B-side claim)
  - `clear_binding_requires_owner_match` (kind AND epoch — FE-R2-1)
  - `stale_epoch_clear_cannot_release_a_replacement_binding` (FE-R2-1, the
    table-level codex double-clear shape: bind epoch N, clear with token N,
    rebind (epoch N+1), clear again with the stale token N → `NotOwned`,
    replacement binding intact)
  - `release_for_conn_releases_only_terminal_holders`
  - `force_release_requires_confirmed_kill`

  RED: the always-`Acquired` stub fails every pin at runtime.

- [ ] **Step 2 (B0.1 GREEN):** implement the one-mutex table and
  canonicalization; rerun the pins; then:

```bash
cargo test -p freshell-terminal session_admission -- --nocapture
cargo test -p freshell-terminal --all-targets
cargo fmt --all --check
cargo clippy -p freshell-terminal --all-targets -- -D warnings
git add crates/freshell-terminal/src/session_admission.rs crates/freshell-terminal/src/lib.rs
git commit -m "feat(terminal): shared cross-kind session admission table"
```

- [ ] **Step 3 (B0.2 RED):** write the deterministic REST-door regression in
  `crates/freshell-freshagent/src/terminal_tabs.rs` tests (compiles against
  current code, fails at runtime — Trace B is deterministic):

  - `rest_terminal_resume_of_live_fresh_agent_session_returns_409` — bind
    `(claude, S)` in `FreshAgentSessionLeases` as a completed fresh-agent
    owner, POST `/api/tabs` with that `sessionRef`, expect
    `409 RESTORE_UNAVAILABLE` and **zero** PTY spawns (recording CLI spec).
  - `rest_legacy_raw_resume_claims_admission_before_spawn` — the legacy rung
    (raw `resumeSessionId`, no parsed ref) also refuses on a cross-kind
    owner (LB13's uncovered rung).

```bash
cargo test -p freshell-freshagent terminal_tabs::tests::rest_terminal_resume_of_live_fresh_agent_session_returns_409 -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::rest_legacy_raw_resume_claims_admission_before_spawn -- --exact --nocapture
```

  Expected RED: both creates succeed today (the hole).

- [ ] **Step 4 (B0.2 GREEN):** convert both lease stores to facades over one
  injected `Arc<SessionAdmission>`. Public APIs and signatures are preserved
  **except the FE-R2-1 token migration:** `FreshAgentSessionLeases::complete`
  (`session_lease.rs:330`) returns the minted `BoundOwner`; the epochless
  `clear_binding(provider, session_id)` (`session_lease.rs:363`) is deleted
  and every production call site migrates to
  `clear_binding_if_owner(provider, sid, &owner)` with the token stored on
  its session entry — codex watcher both arms (`codex.rs:3287`,
  `codex.rs:3295`), codex `handle_kill` (`codex.rs:1245`), claude
  (`claude.rs:1218`), opencode (`opencode_ws.rs:791`); on the terminal side
  `complete_session_ref_claim` stores the token for exit-hook/known-dead
  clears. Add the codex double-clear regression at the facade level:
  `codex_double_clear_cannot_release_a_replacement_binding` (in the codex
  tests: bind S, run the watcher clear, rebind S as a replacement (new
  epoch), then run `handle_kill`'s post-watcher clear with the old token —
  the replacement binding must survive and a subsequent claim on S must
  answer `BoundLive`, not `Acquired`). Update the lease suite's own pins
  mechanically for the token (no other semantic edits).
  Add `SessionRefClaim::OwnedByFreshAgent` — **and, in this same step, every
  exhaustive `SessionRefClaim` match gains the new arm so `cargo check`
  stays green (FE4):** the WS door (`terminal.rs:1496-1534`) and REST door
  (`terminal_tabs.rs:1061-1075`) map it to the D2 errors, and
  `auto_resume.rs::claim_session` (`auto_resume.rs:651-681`) answers
  `false` — a fresh-agent-owned session is never auto-respawned — with unit
  test `auto_resume_claim_refuses_fresh_agent_owned_session` (fake registry
  binding, hub-level claim returns `false`, no respawn attempt). Map the
  claim to 409/`SESSION_RESERVED` per D2 at each door; extend the REST
  door's claim to the legacy rung; wire the single instance in `main.rs`.
  **Amplifier ordering (FE-R3-12):** today `spawn_terminal_pane` runs the
  amplifier `ensure_session` stub block at `terminal_tabs.rs:940-956`
  **before** the D7/D8 admission block at `terminal_tabs.rs:1003-1085`, so
  an admission loser would already have written a provider stub. This step
  moves the admission claim ahead of the amplifier `ensure_session`/stub
  block (the stub itself still precedes `registry.create` — the events-lane
  constraint is claim → stub → create, unchanged where it matters), with
  test `admission_loser_never_writes_amplifier_stub` (bind `(amplifier, S)`
  to a live terminal owner, POST an amplifier resume of S, expect 409 and
  assert the fake amplifier home gained **no** session directory).
  Facade preservation gates:

```bash
cargo test -p freshell-freshagent session_lease -- --nocapture
cargo test -p freshell-terminal session_ref -- --nocapture
cargo test -p freshell-ws --test freshagent_session_lease
cargo test -p freshell-ws --test cross_kind_liveness
cargo test -p freshell-ws auto_resume -- --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::rest_terminal_resume_of_live_fresh_agent_session_returns_409 -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::rest_legacy_raw_resume_claims_admission_before_spawn -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::admission_loser_never_writes_amplifier_stub -- --exact --nocapture
cargo check -p freshell-ws
cargo check -p freshell-server
git add crates/freshell-terminal/src/session_admission.rs \
  crates/freshell-terminal/src/registry.rs \
  crates/freshell-freshagent/src/session_lease.rs \
  crates/freshell-freshagent/src/claude.rs \
  crates/freshell-freshagent/src/codex.rs \
  crates/freshell-freshagent/src/opencode_ws.rs \
  crates/freshell-freshagent/src/terminal_tabs.rs \
  crates/freshell-ws/src/terminal.rs \
  crates/freshell-ws/src/auto_resume.rs \
  crates/freshell-server/src/main.rs
git commit -m "fix(rest): atomic cross-kind session admission closes the REST two-writer hole"
```

- [ ] **Step 5 (B0.3, D5 legacy-WS removal):** in `handle_create`
  (`crates/freshell-ws/src/terminal.rs`): when `!pane_reconcile_v1` and
  `create_session_locator(&create).is_some()`, answer a deterministic
  `send_create_error(ErrorCode::ProtocolMismatch, "This client is too old to
  restore sessions safely. Refresh (F5) and retry.", request_id)` before any
  spawn work. Then remove the legacy check-then-spawn path for
  session-carrying creates: the admission/D8 claim block loses its
  `pane_reconcile_v1` condition (all surviving session-carrying creates are
  negotiated or REST). Keyed-create dedupe stays negotiated-gated
  (identityless legacy creates remain byte-for-byte unchanged). Tests (RED
  first — the reject test fails against current accept-and-spawn behavior):

  - `legacy_connection_session_carrying_create_is_rejected_with_protocol_mismatch`
    (covers both a parsed `sessionRef` and a raw `resumeSessionId` in a
    session mode)
  - `legacy_connection_plain_shell_create_still_works`

```bash
cargo test -p freshell-ws legacy_connection_session_carrying_create_is_rejected_with_protocol_mismatch -- --nocapture
cargo test -p freshell-ws legacy_connection_plain_shell_create_still_works -- --nocapture
cargo test -p freshell-ws --test session_identity_frames
git add crates/freshell-ws/src/terminal.rs
git commit -m "feat(ws)!: require pane_reconcile_v1 for session-carrying terminal creates"
```

- [ ] **Step 6 (B0.4, barrier acceptance):** create
  `crates/freshell-ws/tests/cross_kind_admission.rs` from the
  `cross_kind_liveness.rs` harness (fake sidecar with request log + delayed
  `created` behind a barrier; sleeper CLI blocked behind a second barrier)
  and the `rest_ws_shared_gate.rs` combined WS+REST server. For **each of
  claude, codex, opencode**, in **both** door pairings (WS×fresh-agent,
  REST×fresh-agent), release the barriers in **both orders** plus a
  `tokio::Barrier` simultaneous-send variant, and assert:

  1. exactly one winner (XOR of `terminal.created` / `freshAgent.created`);
  2. the loser's **exact** structured error for its door and contention
     kind (D2, FE-R2-3): cross-kind terminal loser → REST 409
     `RESTORE_UNAVAILABLE` body / WS `error{RESTORE_UNAVAILABLE}` frame;
     fresh-agent loser → `create.failed{SESSION_RESERVED, retryable: true}`;
     plus a same-kind control pairing per door proving WS terminal×terminal
     still answers the existing D8 `SESSION_RESERVED` frame (assert code
     equality, not just refusal), and a **same-kind poisoned control
     (FE-R3-7)**: a WS terminal claim on a key poisoned solely by another
     terminal's conflict hold answers the D8 `SESSION_RESERVED` code, while
     a key with any FreshAgent hold answers `RESTORE_UNAVAILABLE` — the
     mapping reads `Poisoned.holders`;
  3. exactly one writer post-hoc (≤1 sidecar create for S, ≤1 Running row,
     one writer pid in the fake provider transcript);
  4. loser-retry convergence after winner exit + binding clear;
  5. **poisoned-key retry (FE-R2-2, honest D3 shape):**
     `refused_discovery_keeps_key_closed_until_refused_process_exits` — a
     fresh-agent pane owns S; a terminal's discovered identity for S is
     refused (D3-clarified: the process keeps running — this pairing IS the
     documented, alarmed exposure, not a prevented one; the epoch-carrying
     conflict hold is installed here at the table/facade level; the alarm
     *surface* — invariant ERROR + `session.collision.detected` frame — is
     emitted by the Slice F1 helpers and asserted there in
     `refused_discovery_broadcasts_session_collision_frame_and_invariant_log`;
     after Slice F lands, extend this barrier test to assert the frame
     end-to-end); the
     fresh-agent owner exits and its binding clears; a retry create for S
     is **still refused** while the refused terminal runs (no third writer,
     no reopen); the refused terminal exits (its stored hold handle
     released) and the retry then acquires.

  These are the LB14 acceptance gate — they prove **admission** atomicity
  (exactly one winner is ever admitted per key), plus containment + alarm
  for the discovered-collision case; they do not (and cannot) claim the
  two already-running discovered writers are undone. They should pass on
  first run if Steps 2–5 are correct; if any fails, that is a real
  admission bug — fix the table, not the test.

```bash
cargo test -p freshell-ws --test cross_kind_admission -- --nocapture
cargo fmt --all --check
cargo clippy -p freshell-terminal -p freshell-freshagent -p freshell-ws -p freshell-server --all-targets -- -D warnings
git add crates/freshell-ws/tests/cross_kind_admission.rs
git commit -m "test(ws): barrier-proof exactly-one-winner cross-kind admission"
```

---

### Slice B — Atomic registry publication with finalization guard

**Files:** `crates/freshell-terminal/src/registry.rs`.

**Interfaces:**

```rust
pub struct TerminalPublication<'a> {
    pub terminal_id: &'a str,
    pub mode: &'a str,
    pub resume_session_id: Option<&'a str>,
    pub create_request_id: Option<&'a str>,
    pub cwd: Option<&'a str>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionIdentityPublishResult {
    Published,
    AlreadyPublished,
    Missing,
    NotRunning,
    ModeMismatch { actual: String },
    ConflictingIdentity { actual: String },
}

/// Held by the CREATE CALLER through provider settlement, durable write,
/// and announcement enqueue (LB6). The wrapped exit hook waits on it.
/// Drop — on every success, error, and unwind path — opens the gate.
#[must_use]
pub struct CreateFinalizationGuard { /* … */ }

pub fn create_with_publication<F>(
    &self,
    spec: &SpawnSpec,
    child_env: &BTreeMap<String, String>,
    terminal_id: String,
    stream_id: String,
    mode: &str,
    resume_session_id: Option<&str>,
    create_request_id: Option<&str>,
    ring_max_bytes: Option<i64>,
    on_exit: Option<ExitHook>,
    publish: F,
) -> io::Result<CreateFinalizationGuard>
where
    F: FnOnce(TerminalPublication<'_>);

pub fn publish_running_session_identity<F>(
    &self,
    terminal_id: &str,
    provider: &str,
    session_id: &str,
    expected_previous_session_id: Option<&str>,
    publish: F,
) -> SessionIdentityPublishResult
where
    F: FnOnce(TerminalPublication<'_>);

pub fn publish_retired_session_identity<F>(
    &self,
    terminal_id: &str,
    provider: &str,
    session_id: &str,
    expected_previous_session_id: &str,
    publish: F,
) -> SessionIdentityPublishResult
where
    F: FnOnce(TerminalPublication<'_>);
```

Semantics:

- `create_with_publication` order: **pre-reserve the terminal id under
  `RegistryInner` first (FE-R3-9)** — an id already present as a row or a
  live reservation returns an error here, **before any PTY exists** (an
  after-spawn rejection is unsafe even without touching the map: the
  uninserted `PtyTerminal`'s Drop kills its child, `pty.rs:440-451`, its
  reader EOFs and runs the ID-keyed exit hook, `pty.rs:507-515`, and once
  the gate opens that hook would `finish_pty_exit` the pre-existing row);
  then create the finalization gate; wrap `on_exit` so the PTY reader waits
  on it; spawn the PTY; **create the open-on-drop guard immediately after
  successful PTY creation** (LB4); lock `RegistryInner`; run
  duplicate-resume checks; **replace the reservation with the row** (the
  reservation guarantees no duplicate can exist here); invoke `publish`
  synchronously **through the abort-on-panic wrapper** while the row is
  hidden behind the lock (Callback Contract, FE1: the callback is a leaf
  in-memory write; an unwind aborts the process and can never poison the
  mutex); bump the revision; drop the lock; preserve reservation release,
  structured log, and `ActivityEvent::Created` order; return the guard to
  the settlement owner. **Every failure path after id reservation (spawn
  error, duplicate-resume rejection, unwind) drops the id reservation
  under the lock.** `create` delegates with `|_| {}` and drops the guard
  immediately (legacy behavior preserved).
- `publish_running_session_identity` under one `RegistryInner` lock: reject
  missing/non-running rows; require `entry.mode == provider`;
  `AlreadyPublished` (no callback, no revision) when ids match; first
  discovery requires current and expected both `None`; rebind requires the
  current id to equal the nonempty expected id; everything else is
  `ConflictingIdentity`; set the id, invoke the callback, bump the revision,
  return `Published`. No broadcast, ledger write, locator operation, or
  async work inside.
- `publish_retired_session_identity` shares the transition helper; requires
  an existing **non-running** row with the exact expected previous id;
  changes only id/revision; leaves exit status/code untouched. An **absent**
  row returns `Missing` — the sink-level retired lane (Slice F3) handles the
  LB9 missing-row case above the registry; this method never fabricates
  rows.

- [ ] **Step 1 (RED):** land the types and **naive stubs** (delegate to
  `create` then invoke the publisher outside the lock without the abort
  wrapper; guard opens immediately; publish methods return `Missing`)
  together with all fourteen tests, using barriers/channels, never sleeps:

  - `create_publication_hides_row_until_identity_callback_completes`
  - `immediate_exit_waits_for_finalization_guard`
  - `exit_hook_cannot_run_before_caller_settlement_completes` (LB6: the
    settlement owner holds the guard across a barrier standing in for
    durable-write + announcement; exit hook order-asserted after)
  - `publisher_panic_aborts_the_process` (FE1, subprocess test: re-exec the
    current test binary — `std::env::current_exe()` — with
    `FRESHELL_TEST_PANICKING_PUBLISHER=1` selecting a helper test that
    installs a panicking publisher; assert the child terminates abnormally
    by **abort** (`!status.success()` and, on unix, `SIGABRT`), and that
    stderr shows the abort wrapper's invariant message, not an ordinary
    unwinding panic or a poisoned-mutex panic. RED against the naive stub:
    the child unwinds normally instead of aborting, so the assertion fails
    at runtime.)
  - `registry_remains_usable_after_duplicate_id_rejection` (FE1 error path:
    a duplicate create fails with an error return; a subsequent create,
    list, and kill on the same registry all succeed — no poisoning, no
    leftover row **or leftover id reservation** from the rejected create)
  - `duplicate_terminal_id_rejects_before_spawn_and_preexisting_terminal_stays_running`
    (LB4 + FE-R3-9: with a Running terminal on id T, a second
    `create_with_publication` for T fails at reservation time — a recording
    spawn observer proves **zero** PTY spawns for the loser — and the
    pre-existing terminal stays Running with its exit hook never invoked
    and no `Exit` activity event emitted)
  - `spawn_failure_clears_the_terminal_id_reservation` (FE-R3-9: a create
    whose spawn fails releases the reservation; an immediate retry on the
    same id succeeds)
  - `discovered_identity_updates_running_row_and_callback_atomically`
  - `discovered_identity_cannot_publish_after_exit` (calls
    `finish_pty_exit` first; requires `NotRunning` + zero callbacks)
  - `expected_previous_identity_allows_atomic_rebind`
  - `stale_previous_identity_cannot_overwrite_current_binding`
  - `retired_rebind_updates_identity_without_changing_exit_status`
  - `retired_rebind_requires_expected_previous_identity`
  - `create_wrapper_preserves_legacy_behavior`

  RED: atomicity/ordering/result/abort assertions fail at runtime against
  the naive stubs.

- [ ] **Step 2 (GREEN + refactor):** implement the id pre-reservation, the
  gate/lock ordering, the abort-on-panic wrapper, and the transitions; run
  **all fourteen** focused (no drift — every declared test is run):

```bash
cargo test -p freshell-terminal registry::tests::create_publication_hides_row_until_identity_callback_completes -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::immediate_exit_waits_for_finalization_guard -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::exit_hook_cannot_run_before_caller_settlement_completes -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::publisher_panic_aborts_the_process -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::registry_remains_usable_after_duplicate_id_rejection -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::duplicate_terminal_id_rejects_before_spawn_and_preexisting_terminal_stays_running -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::spawn_failure_clears_the_terminal_id_reservation -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::discovered_identity_updates_running_row_and_callback_atomically -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::discovered_identity_cannot_publish_after_exit -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::expected_previous_identity_allows_atomic_rebind -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::stale_previous_identity_cannot_overwrite_current_binding -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::retired_rebind_updates_identity_without_changing_exit_status -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::retired_rebind_requires_expected_previous_identity -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::create_wrapper_preserves_legacy_behavior -- --exact --nocapture
cargo test -p freshell-terminal --all-targets
cargo fmt --all --check
cargo clippy -p freshell-terminal --all-targets -- -D warnings
```

- [ ] **Step 3 (Commit):**

```bash
git add crates/freshell-terminal/src/registry.rs
git commit -m "feat(terminal): publish session identity atomically"
```

---

### Slice C — Durable-ledger and identity-registry primitives

Two commits, both on the `freshell-ws` lib test target.

- [ ] **C1 (LB8):** in `crates/freshell-ws/src/pane_ledger.rs` (+
  `pane_ledger_tests.rs`), add:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnedLedgerMutation { Applied, NotOwned, Disabled }

pub fn retire_closed_if_owned(
    &self,
    provider: &str,
    session_id: &str,
    terminal_id: &str,
    create_request_id: Option<&str>,
) -> std::io::Result<OwnedLedgerMutation>;

pub fn delete_pending_if_owned(
    &self,
    terminal_id: &str,
    create_request_id: Option<&str>,
) -> std::io::Result<OwnedLedgerMutation>;
```

  Pending markers gain the create-request epoch. Lookup, comparison, and
  mutation all run under the one ledger guard. A mismatch is `NotOwned`,
  never a mutation. RED: land stubs returning `NotOwned` always, plus tests

  - `retire_closed_if_owned_retires_only_the_matching_epoch`
  - `stale_cleanup_cannot_retire_a_replacement_owner` (barrier: pause old
    cleanup, bind a replacement, release; replacement stays Bound/live)
  - `delete_pending_if_owned_requires_epoch_match`
  - `enabled_binding_reloads_after_ordinary_restart`

  GREEN, then:

```bash
cargo test -p freshell-ws pane_ledger_tests:: -- --nocapture
cargo fmt --all --check
cargo clippy -p freshell-ws --all-targets -- -D warnings
git add crates/freshell-ws/src/pane_ledger.rs crates/freshell-ws/src/pane_ledger_tests.rs
git commit -m "feat(ws): epoch-guarded pane-ledger retirement and pending markers"
```

- [ ] **C2:** in `crates/freshell-ws/src/identity.rs`, add the leaf
  single-write-lock method:

```rust
pub fn upsert_with_retirement(
    &self,
    terminal_id: &str,
    provider: Option<&str>,
    session_id: Option<&str>,
    cwd: Option<&str>,
    updated_at: i64,
    retired: bool,
)
```

  Existing `upsert` delegates with `retired = false`. Never implement retired
  publication as `upsert()` then `retire()` (transient live row between
  locks). RED: stub delegates to existing `upsert` (ignores `retired`) →
  `retired_identity_upsert_is_never_visible_in_live_identity_list` fails at
  runtime. GREEN, then:

```bash
cargo test -p freshell-ws identity::tests::retired_identity_upsert_is_never_visible_in_live_identity_list -- --exact --nocapture
cargo test -p freshell-ws identity::tests -- --nocapture
git add crates/freshell-ws/src/identity.rs
git commit -m "feat(ws): atomic retired-aware identity upsert"
```

---

### Slice D — Production sink in `freshell-ws`, trait extension, boot wiring

Resolves LB18, LB2, LB1, LB3 (adapter test), LB7 (retirement semantics),
LB13 (authorization order), and stores LB12's deferred markers.

**Files:** `crates/freshell-freshagent/src/identity_sink.rs` (trait methods —
land with default bodies, flip to required in this same slice; extended
`FakeIdentitySink`), **new** `crates/freshell-ws/src/identity_sink.rs`,
`crates/freshell-ws/src/lib.rs` (`WsState` carries the sink +
`identity_sink_wired()`), `crates/freshell-freshagent/src/{lib,claude,codex,opencode_ws}.rs`
(loud setters + assertion accessors), `crates/freshell-server/src/identity_sink.rs`
(shrinks to construction glue + test harness),
`crates/freshell-server/src/main.rs` (one sink, five consumers, boot
assertions, weak probes), `crates/freshell-server/src/existence.rs` (+ trait
touch in `crates/freshell-ws/src/existence.rs` if needed) for the
legacy-adjudication probe variant, and
`crates/freshell-sessions/src/directory_index.rs` for the atomic
`peek_with_freshness()` (FE-R2-5) that `exists_with_freshness` consumes.

**Trait additions to `PaneIdentitySink`** (existing `record_pending`,
`record_binding`, `load_settings`, `was_recorded` stay source-compatible):

```rust
fn authorize_terminal_identity(&self, candidate: TerminalIdentityCandidate)
    -> TerminalAuthorization;

fn publish_terminal_identity_memory(
    &self,
    identity: &AuthorizedTerminalIdentity,
    visibility: TerminalIdentityVisibility,
);

fn persist_terminal_identity(
    &self,
    identity: AuthorizedTerminalIdentity,
    phase: TerminalDurabilityPhase,
) -> TerminalDurabilityWrite;

fn persist_terminal_pending(&self, pending: TerminalPendingIdentity)
    -> TerminalDurabilityWrite;

// Synchronous-callable from the PTY reader hook; returns an awaitable
// completion (FE-R2-8). `handle_kill` MUST await it for ExplicitClose
// (preserving today's awaited semantics, ws/terminal.rs:3880-3903);
// NaturalExit callers may drop it.
fn retire_terminal_identity(&self, terminal_id: &str, cause: TerminalExitCause)
    -> TerminalRetirementCompletion;
// alias next to the others:
// pub type TerminalRetirementCompletion =
//     Pin<Box<dyn Future<Output = TerminalIdentityDurability> + Send + 'static>>;

fn defer_legacy_reauthorization(&self, candidate: TerminalIdentityCandidate);
fn drop_legacy_reauthorization(&self, terminal_id: &str);

fn announce_terminal_identity(&self, announcement: TerminalIdentityAnnouncement);

// PIN2 exception (LB5 rescope, FE3): the ONLY pre-spawn durable write,
// absorbed from the landed binder; minted-fresh-Claude lane only. The
// delete twin runs on spawn failure.
fn persist_prespawn_minted_claude_binding(
    &self,
    identity: AuthorizedTerminalIdentity, // provenance == ServerPreallocated
) -> TerminalDurabilityWrite;
fn delete_prespawn_minted_claude_binding(&self, session_id: String)
    -> TerminalDurabilityWrite;
```

(`TerminalAuthorization`/`TerminalDurabilityWrite` are the existing
boxed-future aliases. There is **no** general
`delete_terminal_binding_if_owned` trait method: with general pre-spawn
writes removed, its only consumer is gone; the sole pre-spawn delete is the
typed PIN2 twin above, and epoch-guarded cleanup goes through
`retire_terminal_identity`'s `ExplicitClose` lane and the C1 primitives.)

**Production sink** (`crates/freshell-ws/src/identity_sink.rs`):

```rust
pub struct LedgerIdentitySink { /* … */ }

// Defined next to the sink, owned-argument closures so futures are 'static;
// production closures capture Weak state projections (LB1):
pub type FreshAgentOwnerFuture =
    Pin<Box<dyn Future<Output = bool> + Send + 'static>>;
pub type FreshAgentOwnerProbe = Arc<
    dyn Fn(String, String) -> FreshAgentOwnerFuture + Send + Sync + 'static,
>;

pub fn new(
    ledger: Arc<PaneLedger>,
    identity: TerminalIdentityRegistry,
    registry: TerminalRegistry, // for the live_session_owner join (ws already depends on freshell-terminal)
    existence: SharedExistenceProbe,
    fresh_agent_owner: FreshAgentOwnerProbe,
    broadcast_tx: Arc<broadcast::Sender<String>>,
    terminals_revision: Arc<AtomicI64>,
    runtime: tokio::runtime::Handle,
) -> Self
```

Behavior:

- Authorization implements the exact order in "Authorization Ordering"
  (live-owner checks for **all** candidates before existence mapping, with
  the registry row join **excluding the candidate's own `terminal_id`** —
  FE-R3-6); the amplifier arm of the owner probe answers `false` (no
  runtime today; adding one is a table entry).
- `publish_terminal_identity_memory` maps visibility to
  `upsert_with_retirement` only (leaf; Callback Contract documented on the
  method).
- Durability methods: typed `LedgerUnavailable` when `!ledger.is_enabled()`;
  event time captured before `spawn_blocking`; success → `Durable`; I/O
  error vs `JoinError` → distinct typed variants. `Discovery` writes the
  binding first, then the epoch-guarded pending delete; a pending-delete
  failure logs but never downgrades a durable binding.
- **Publication-time ownership record (FE-R3-11):** a `terminal_id`-only
  retirement cannot drive the epoch-conditional C1 primitives — they need
  `(provider, session_id, terminal_id, create_request_id)`, `handle_kill`
  removes the registry row **before** retirement runs (`kill_internal`,
  `registry.rs:1444-1503`), and reading the current ledger row to learn
  "what to retire" is tautological. The sink therefore keeps an internal
  map `terminal_id → PublishedOwnership { provider, session_id,
  create_request_id, admission_epoch }`, captured **at publication time**
  (inserted by `publish_terminal_identity_memory(Live)` for both create
  and discovery lanes; replaced wholesale on a rebind; immutable
  otherwise) and removed when the retirement cleanup job settles.
  `retire_terminal_identity` resolves its expected values **from this
  record, never from live registry/ledger state**; a terminal with no
  record retires memory only (nothing was ever published for it).
- `retire_terminal_identity(terminal_id, cause)` is synchronous-callable from
  the PTY reader hook: it marks the in-memory identity retired immediately
  (retained), drops any deferred re-auth marker, then spawns one ordered
  async cleanup job via the runtime handle. The cleanup job runs
  `delete_pending_if_owned` for **every** cause (FE-R2-7 — natural exit
  must keep deleting durable pending markers, current production behavior),
  and additionally `retire_closed_if_owned` for `ExplicitClose` only; both
  on `spawn_blocking`. The method returns a `TerminalRetirementCompletion`
  resolving when the cleanup job settles (FE-R2-8): production
  `handle_kill` awaits it before completing so a kill response is never
  emitted ahead of the ledger retirement (today's awaited contract,
  `ws/terminal.rs:3880-3903`); the natural-exit reader hook drops it
  (fire-and-forget is safe there — nothing downstream depends on marker
  deletion completing before the hook returns). The same completion serves
  deterministic test waits.
- `announce_terminal_identity` enqueues, per event:

```text
Created:    [one durability.degraded if degraded] -> terminals.changed -> meta (if identity)
Associated: [one durability.degraded if degraded] -> associated -> terminals.changed -> meta
```

  It owns the shared revision increment and announcement dedupe.

**Boot wiring (`main.rs`):** construct states → registries/ledger/probe →
build `FreshAgentOwnerProbe` from **Weak** projections → construct one
`LedgerIdentitySink` → set into all four fresh states with loud failure →
construct `WsState` with a clone → assert **all five**
`identity_sink_wired()` **and** `Arc::ptr_eq` against the constructed sink,
alongside the existing spawn-gate assertion (`main.rs:509-516` template).

**`WsState` blast radius (FE5):** `WsState` gains
`pub identity_sink: Arc<dyn PaneIdentitySink>`. `WsState` is constructed by
struct literal in **~38 places**, and every one must be updated in this
slice or the workspace stops compiling. Source sites:
`crates/freshell-server/src/main.rs` (1), `crates/freshell-ws/src/lib.rs`
(incl. the `state()` unit-test helper), `spawn_gate.rs` (1),
`terminal.rs` (2), `codex_association.rs` (1), `opencode_association.rs`
(1). Test sites: `crates/freshell-ws/tests/common/mod.rs` (**8** literals)
and one literal each in `claude_session_rebind.rs`,
`codex_managed_launch_e2e.rs`, `codex_session_ref_resume.rs`,
`cross_kind_liveness.rs`, `diag01_lifecycle_events.rs`,
`freshagent_claude_attach.rs`, `freshagent_claude_kill_interrupt.rs`,
`freshagent_session_lease.rs`, `hello_timeout.rs`, `keepalive.rs`,
`max_payload.rs`, `opencode_switch_rebind.rs`, `origin_policy.rs`,
`pane_reconcile_freshagent.rs`, `pane_reconcile.rs`,
`rest_claude_identity.rs`, `rest_locator_identity.rs`,
`restore_spawn_gate.rs`, `rest_ws_shared_gate.rs`,
`safe08_restore_diagnostics.rs`, `term09_output_queue.rs`. Containment:
export `freshell_ws::identity_sink::null_sink_for_tests() ->
Arc<dyn PaneIdentitySink>` (a cheap always-compiled recording no-op,
`#[doc(hidden)]`; it also seeds Slice F0's `RecordingSink`) so each literal
adds exactly one line. Do **not** introduce a `Default`/builder for
`WsState` here — most fields are not defaultable; enumeration plus the
one-liner is the contained fix. `cargo test -p freshell-ws --all-targets`
(compile + run) is part of this slice's GREEN gate, precisely to catch any
missed literal.

- [ ] **Step 1 (RED):** land trait methods with temporary default bodies
  (authorize → always `Reject(ProviderUnavailable)`, persist → `Degraded`,
  retire/defer/announce → recording no-ops), the extended
  `FakeIdentitySink`, the production sink skeleton with the same stub
  behavior, and the tests:

  freshagent lib (`identity_sink::tests`):
  - `fake_sink_records_terminal_phases_separately`
  - `legacy_resume_requires_present_existence_before_authorization`
  - `accepted_minted_and_discovered_sources_authorize_without_legacy_inference`

  freshell-ws lib (`identity_sink::tests` — production adapter):
  - `terminal_memory_publication_is_synchronous_and_filesystem_free`
  - `terminal_binding_reloads_from_a_new_ledger_instance`
  - `disabled_ledger_is_typed_degraded_not_durable`
  - `write_and_join_failures_are_machine_distinct`
  - `live_claude_codex_and_opencode_fresh_owners_are_rejected`
  - `live_owner_rejection_precedes_existence_even_when_unknown` (LB13: live
    owner + `Unknown` existence → `LiveFreshAgentOwner`, not
    `LegacyIdentityUnconfirmed`)
  - `live_owner_check_exempts_the_candidates_own_terminal_row` (FE-R3-6:
    with the candidate's own terminal Running and carrying
    `resume_session_id == candidate.session_id`, authorization does NOT
    reject `LiveFreshAgentOwner`; a second, foreign Running row on the same
    id still rejects)
  - `amplifier_uses_the_provider_aware_no_runtime_arm`
  - `legacy_adjudication_ignores_zero_turn_broker_stubs` (LB15 probe arm,
    fake existence source)
  - `stale_snapshot_absent_is_deferrable_and_fresh_absent_is_permanent`
    (FE6: fake probe answers `Absent` with `index_fresh: false` →
    `LegacyIdentityUnconfirmed`; `index_fresh: true` →
    `LegacyIdentityAbsent`)
  - `provider_unavailable_is_a_permanent_rejection` (FE7)
  - `prespawn_minted_claude_binding_writes_bound_row_and_delete_removes_it`
    (ported from the landed binder unit tests; PIN2 exception via the sink)
  - `natural_exit_retires_memory_but_leaves_ledger_bound` (LB7)
  - `natural_exit_deletes_pending_marker_and_leaves_binding_bound`
    (FE-R2-7: NaturalExit runs `delete_pending_if_owned` — the ported
    binder pin `retire_pane_identity_retires_row_and_clears_pending`'s
    pending-delete half stays true through the migration)
  - `explicit_close_retires_ledger_via_epoch_guard` (LB7/LB8; the test
    awaits the returned `TerminalRetirementCompletion` — FE-R2-8)
  - `explicit_close_retirement_resolves_ownership_from_the_publication_record`
    (FE-R3-11: publish `(P, S)` for T1, then remove T1's registry row —
    mirroring `handle_kill`'s remove-first order — and retire with
    `ExplicitClose`; the sink still calls
    `retire_closed_if_owned(P, S, T1, req1)` from its publication-time
    record and the row retires. Replacement-safety half: rebind S's ledger
    row to a replacement terminal T2 first; T1's delayed retirement then
    answers `NotOwned` and T2's row stays `Bound`. The record is removed
    once the cleanup job settles)
  - `retirement_retires_memory_then_runs_ledger_cleanup_off_reader_thread`
  - `retirement_completion_resolves_only_after_ledger_cleanup_settles`
    (FE-R2-8: barrier-gated ledger; the completion must not resolve before
    the blocking job finishes)

  freshell-sessions lib (`directory_index::tests`):
  - `peek_with_freshness_pairs_snapshot_and_freshness_from_one_guard_read`
    (FE-R2-5: items, `fresh`, and `generation` all from one lock
    acquisition; a stale snapshot can never be paired with another
    generation's freshness — see the probe-contract section for the full
    fixture)

  freshell-server bin (`existence::tests`):
  - `exists_with_freshness_reports_stale_snapshot_absent_as_unfresh` (FE6:
    seeded index, session written after the snapshot; `exists` alone says
    `Absent`, `exists_with_freshness` says `Absent` + `index_fresh: false`;
    implemented over `peek_with_freshness` — never `peek()` + `is_fresh()`
    composed (FE-R2-5); companion to the existing
    `session_written_after_cold_read_resolves_present_on_requery`)

  freshell-server bin (`identity_sink::tests`):
  - `boot_wires_one_pointer_identical_sink_into_all_five_consumers` (LB2)
  - `sink_and_states_deallocate_when_server_handles_drop` (LB1 teardown:
    Weak upgrades fail after externals drop)

  Fake fresh-agent owner functions are injected per provider; no real
  sidecars. RED: all fail at runtime against the stubs.

- [ ] **Step 2 (GREEN):** implement the sink; flip trait defaults to required
  methods **in this slice** (both implementers exist and update together);
  wire boot.

```bash
cargo test -p freshell-freshagent identity_sink::tests -- --nocapture
cargo test -p freshell-ws identity_sink::tests -- --nocapture
cargo test -p freshell-server identity_sink::tests -- --nocapture
cargo test -p freshell-server existence::tests -- --nocapture
cargo test -p freshell-sessions directory_index::tests::peek_with_freshness_pairs_snapshot_and_freshness_from_one_guard_read -- --exact --nocapture
cargo test -p freshell-ws --all-targets   # FE5 gate: every WsState literal updated
cargo check -p freshell-server
cargo fmt --all --check
cargo clippy -p freshell-sessions -p freshell-freshagent -p freshell-ws -p freshell-server --all-targets -- -D warnings
```

- [ ] **Step 3 (Commit):**

```bash
git add crates/freshell-freshagent/src/identity_sink.rs \
  crates/freshell-freshagent/src/lib.rs \
  crates/freshell-freshagent/src/claude.rs \
  crates/freshell-freshagent/src/codex.rs \
  crates/freshell-freshagent/src/opencode_ws.rs \
  crates/freshell-sessions/src/directory_index.rs \
  crates/freshell-ws/src/identity_sink.rs \
  crates/freshell-ws/src/lib.rs \
  crates/freshell-ws/src/existence.rs \
  crates/freshell-server/src/identity_sink.rs \
  crates/freshell-server/src/existence.rs \
  crates/freshell-server/src/main.rs
git commit -m "feat(ws): shared terminal identity sink with typed durability and boot wiring"
```

---

### Slice E1 — Fresh-Claude preallocation predicate — **LANDED in #584 (verify only)**

PR #584 landed exactly this slice:
`freshell_platform::should_preallocate_fresh_claude`
(`crates/freshell-platform/src/cli_launch.rs:616-626`) with the truth-table
test `fresh_claude_preallocation_predicate_truth_table` (`cli_launch.rs:693+`),
already consumed by **both** doors (WS `terminal.rs` and REST
`terminal_tabs.rs`). There is no work in this slice and no commit.

- [ ] **Verify only** (fully qualified path — the bare name with `--exact`
  selects zero tests and passes vacuously, FE-R2-11; require `1 passed` in
  the summary):

```bash
cargo test -p freshell-platform cli_launch::tests::fresh_claude_preallocation_predicate_truth_table -- --exact --nocapture
```

---

### Slice E2 — REST provenance-aware publication (absorbs the landed binder)

The incident fix itself landed in #584 (see Reconciliation) — the old RED
tuple `(None, None, Some("981008-old-gf-ui"))` is impossible on `6147c700`,
and the exact `gf ui` shape becomes a green acceptance pin in Slice I.
Genuine runtime REDs remain because the landed binder is provenance-blind
(it publishes even unvalidated legacy raw ids), and the REST door still
lacks the FE10 rejection ladder, authorization ordering, deferred markers,
cause-aware retirement, atomic publication, and scoped pane promotion.

**Files:** `crates/freshell-freshagent/src/terminal_tabs.rs`,
`crates/freshell-freshagent/src/lib.rs` (remove `with_pane_identity_binder`
and the `pane_identity` field), **delete**
`crates/freshell-ws/src/pane_identity_binder.rs`,
`crates/freshell-terminal/src/registry.rs` (remove the `PaneIdentityBinder`
trait), `crates/freshell-ws/src/identity_sink.rs` (receive the ported binder
unit tests), `crates/freshell-server/src/main.rs` (wiring swap: binder out,
nothing new in — the sink is already wired from Slice D).

**Interfaces:** the landed `derive_resume_identity` already returns the
pre-provider-filter parse result (#584); extend its return shape as needed:

```rust
pub(crate) struct DerivedResumeIdentity {
    pub launch_session_id: Option<String>,
    pub accepted_session_ref: Option<SessionLocator>,
    pub legacy_resume_session_id: Option<String>,
    pub parsed_session_ref_present: bool,
}
```

plus `authorized_identity: Option<AuthorizedTerminalIdentity>` and
`durability: Option<TerminalIdentityDurability>` threaded through the owned
settle inputs/spawn result as needed (`GatedSettleInputs` already carries
`claude_fresh_prealloc`).

- [ ] **Step 1 (RED, all runtime, all in-slice):** in `terminal_tabs::tests`,
  the route matrix (against the Slice D sink API, which exists — genuine
  runtime REDs). **Observation seam (FE-R3-14):** every test here observes
  the **injected `FakeIdentitySink`** (recorded calls, arguments, and typed
  provenance) — `freshell-freshagent` cannot import the production
  `PaneLedger` (dependency direction: `freshell-ws → freshell-freshagent`;
  the crate's own `Cargo.toml` documents that depending on `freshell-ws`
  would be circular), so real-ledger persistence and reload proof lives in
  the ws targets (Slice D unit tests, the landed #584 integration pins, and
  Slice I):

  - `fresh_claude_rest_create_uses_start_and_publishes_minted_identity`
    (minting landed in #584; the *publication-through-the-sink* assertion is
    the RED)
  - `explicit_claude_codex_opencode_and_amplifier_refs_publish_identity`
    (four recording CLI specs; per provider, the fake sink records
    candidate → authorize → publish-memory → persist(Postspawn) with the
    request's exact ref and typed provenance `AcceptedSessionRef`;
    directory/identity/reloaded-ledger equality is asserted in Slice I's
    `explicit_refs_publish_for_all_four_terminal_providers` — FE-R3-14)
  - `fresh_amplifier_preserves_stub_before_spawn_and_publishes_minted_identity`
    (recording executable checks `events.jsonl` existed at process start and
    argv carries the minted UUID in resume position)
  - `amplifier_legacy_raw_id_is_probed_before_any_stub_write` (LB15: a
    never-existing raw id must NOT be re-stubbed; existence adjudication
    happens first; rescope/replace the old
    `requested_amplifier_resume_with_missing_dir_is_restubbed_under_same_id`
    expectation for the legacy arm — accepted/minted arms unchanged)
  - `raw_resume_publishes_only_after_present_existence` (**genuine RED on
    `6147c700`:** the landed binder publishes any session-carrying create;
    under this plan a raw id publishes only on `Present`)
  - `raw_resume_unknown_or_stale_absent_launches_and_records_deferred_marker`
    (LB12/FE6 arm: launch OK, no published identity, marker recorded via
    fake sink; no pane `sessionRef` promotion)
  - `raw_resume_fresh_absent_or_provider_unavailable_warns_permanently`
    (FE6/FE7: launch OK, structured warning, no marker, never deferred)
  - `cross_provider_session_ref_is_rejected_400_before_spawn` (FE10: POST
    `mode:"claude"` with a codex `sessionRef` → 400
    `SESSION_REF_PROVIDER_MISMATCH`, zero PTY spawns — today this launches a
    bare unresumable claude)
  - `claude_restore_true_without_identity_is_rejected_422` (FE10: mirror of
    the WS `error_claude_restore_unresolved` ladder → 422
    `CLAUDE_RESTORE_UNRESOLVED`, zero spawns — today this launches a bare
    claude with neither `--session-id` nor `--resume`)
  - `amplifier_restore_true_without_id_still_launches_bare` (pin of the
    landed, documented amplifier restore-bare carve-out — deliberate, not
    an FE10 defect)
  - `pane_content_session_ref_is_stamped_only_for_authorized_identities`
    (four providers; gemini/kimi promotion untouched — carve-out pin)
  - `spawn_failure_deletes_prespawn_row_writes_nothing_else_and_frees_admission`
    (post-spawn-only durability except PIN2: the minted-claude pre-spawn row
    is deleted by the landed failure-delete twin, now via the sink; the
    admission lease is released)
  - `immediate_exit_retires_after_atomic_publication`
  - `natural_exit_leaves_ledger_bound_and_deletes_pending_marker`
    (route-level LB7 + FE-R2-7, observed on the fake sink per FE-R3-14:
    the exit hook calls `retire_terminal_identity(id, NaturalExit)` —
    never `ExplicitClose`, asserted by the absence of any `ExplicitClose`
    call in `terminal_tabs.rs` per FE8 — and the fake records the
    pending-delete without any `Closed` retirement; the real
    ledger-stays-`Bound` half is proven by Slice D's ws test
    `natural_exit_retires_memory_but_leaves_ledger_bound`)
  - `client_abort_mid_create_still_completes_settlement` (FE9 + FE-R3-8:
    start a create against a barrier-gated recording CLI, drop the HTTP
    handler/response future mid-flight — cover both drop points: **before
    the phase-one result is consumed** and **after phase one but before the
    announcement plan is sent** — release the barrier; assert identity
    published, durable write completed, the **fallback deferred-shape
    announcement** (`terminals.changed -> terminal.meta.updated`, no
    `ui.command`) enqueued by the settle task after it observes the
    dropped `announce_tx`/failed `result_tx` send, and the finalization
    guard dropped only after settlement — the detached settle task owns
    the guard through both phases and always finishes)
  - `kill_during_settlement_skips_created_and_cleans_up_epoch_conditionally`
    (FE-R3-10: barrier between publication and announcement; kill the
    terminal via the registry mid-hold — `kill_internal` removes the row
    and marks it exited before dropping the PTY, `registry.rs:1444-1503` —
    release; assert **no** `ui.command`/`Created` shape was enqueued, only
    `terminals.changed`, the epoch-conditional pending cleanup ran, and
    the settle task still completed and dropped the guard)
  - `tab_split_and_respawn_share_the_known_identity_pipeline` (the landed
    split/respawn mint pins stay green alongside)

- [ ] **Step 2 (GREEN):** implement in `terminal_tabs.rs`:

  1. `DerivedResumeIdentity` (use `parsed_session_ref_present`, not raw JSON
     field presence; `"sessionRef": null` is absent and still mints — landed
     semantics). **FE10 rejection ladder, before any spawn work:** a parsed
     ref whose provider ≠ mode → 400 `SESSION_REF_PROVIDER_MISMATCH` (all
     four providers); claude `restore: true` with no accepted ref and no
     resume id → 422 `CLAUDE_RESTORE_UNRESOLVED`; the amplifier restore-bare
     carve-out and `INVALID_RAW_CODEX_RESUME_MESSAGE` behavior stay
     verbatim.
  2. Fresh-Claude minting: landed in #584 — keep; route the PIN2 pre-spawn
     binding and its failure delete through the sink's typed methods
     (migrated binder call sites).
  3. Amplifier: preserve mint/stub/cwd logic; `ServerPreallocated` only when
     this request minted the UUID; **legacy raw ids run probe-only existence
     authorization before `ensure_session`** (LB15); stub still precedes
     `registry.create`.
  4. Candidate construction + `authorize_terminal_identity` before spawn
     (admission claim already precedes it from Slice B0). On
     `LiveFreshAgentOwner` → existing planned-launch/stub cleanup +
     `409 RESTORE_UNAVAILABLE`. On deferrable legacy rejection → launch,
     `authorized_identity = None`, `defer_legacy_reauthorization`, structured
     log. On permanent rejection (`LegacyIdentityAbsent` fresh,
     `ProviderUnavailable`) → launch, structured warning only.
     Managed-Codex planner id mismatch → 500 before spawn.
  5. `create_with_publication` with the synchronous memory-publish callback
     (`debug_assert_eq!` terminal ids); the **detached settle task** holds
     the returned `CreateFinalizationGuard` through settlement AND
     announcement via the **two-phase settle handoff with a phase-one
     result channel** (FE9 + FE-R3-8, exactly per Lifecycle Corrections:
     the settle task sends the creation result over `result_tx` without
     finishing; `spawn_terminal_pane` returns that result plus the
     `{announce_tx, ack_rx}` handle instead of awaiting the `JoinHandle`;
     the route sends its `AnnouncementPlan` after bookkeeping and awaits
     the ack; the settle task re-checks the row is still Running
     (FE-R3-10), enqueues, acks, then drops the guard; every
     dropped-sender case falls back to the deferred shape — no timeouts)
     — never the HTTP handler; a settle-task panic before the phase-one
     send surfaces to the route as a `RecvError` → 500 (replacing today's
     `JoinError` arm, `terminal_tabs.rs:1165`); exit hook calls
     `retire_terminal_identity(id, NaturalExit)` after `finish_pty_exit`
     (completion dropped — FE-R2-8's await applies to `ExplicitClose`,
     which has no REST path). No REST code path passes `ExplicitClose`
     (FE8).
  6. Post-spawn awaited `persist_terminal_identity(…, Postspawn)` for every
     authorized identity (single result, no settlement aggregation).
     `persist_terminal_pending` for identityless fresh Codex/OpenCode
     creates, epoch-keyed.
  7. Scoped pane promotion per LB10 consumer table.
  8. **Binder absorption (FE3):** swap the four binder call sites to the
     sink; port the binder unit tests into ws `identity_sink::tests`; delete
     `pane_identity_binder.rs`, the `PaneIdentityBinder` trait, the
     `pane_identity` field, and the `main.rs` binder wiring — all in this
     slice, leaving no parallel write path. The landed integration pins
     (`rest_claude_identity.rs`, `rest_locator_identity.rs`,
     `pane_ledger_restore.rs`) must stay green; if one asserts unvalidated
     raw-id publication, rescope it to an accepted-ref or
     `Present`-existence fixture and record the delta in the report.

```bash
cargo test -p freshell-freshagent terminal_tabs::tests -- --nocapture
cargo test -p freshell-ws identity_sink::tests -- --nocapture
cargo test -p freshell-ws --test rest_claude_identity
cargo test -p freshell-ws --test rest_locator_identity
cargo test -p freshell-ws --test pane_ledger_restore
cargo test -p freshell-freshagent --all-targets
cargo check -p freshell-ws
cargo fmt --all --check
cargo clippy -p freshell-freshagent -p freshell-ws -p freshell-terminal -p freshell-server --all-targets -- -D warnings
```

- [ ] **Step 3 (Commit):**

```bash
git add crates/freshell-freshagent/src/terminal_tabs.rs \
  crates/freshell-freshagent/src/lib.rs \
  crates/freshell-ws/src/pane_identity_binder.rs \
  crates/freshell-ws/src/identity_sink.rs \
  crates/freshell-ws/src/lib.rs \
  crates/freshell-terminal/src/registry.rs \
  crates/freshell-server/src/main.rs
git commit -m "fix(rest): provenance-aware terminal identity publication absorbs the binder"
```

---

### Slice F — Discovered/rebind publication through the shared sink

All `freshell-ws`; five sub-commits. Helpers live in the new focused module
`crates/freshell-ws/src/terminal_identity_publication.rs` (the previous
revision's `codex_identity.rs`-vs-`codex_association.rs` ambiguity is
resolved: association write tails and their tests stay in
`codex_association.rs`/`opencode_association.rs`; the shared helpers get
their own module):

```rust
pub(crate) async fn publish_discovered_terminal_identity(
    state: &WsState,
    candidate: TerminalIdentityCandidate,
    previous_session_id: Option<String>,
) -> SessionIdentityPublishResult;

pub(crate) async fn publish_retired_signal_identity(
    state: &WsState,
    candidate: TerminalIdentityCandidate,
    previous_session_id: String,
) -> SessionIdentityPublishResult;
```

Discovered algorithm (with ownership + rollback, FE-R3-4):
`claim_discovered(claimant, prior)` on the admission table — `prior` is the
terminal's stored token if it has one (a legacy-resume terminal's
create-door token; a locator re-fire's earlier discovery token), else
`None`. On `Refused`: atomic refusal, deduped conflict hold installed
(FE-R2-2/FE-R3-3), D3-clarified loud surface fired (the
`discovered_session_collision_refused` invariant ERROR **and** one
`session.collision.detected` broadcast frame — see "Admission invariant,
stated honestly"), process left running, and the returned
`ConflictHoldHandle` stored on the terminal's registry row via
`registry.store_conflict_hold(terminal_id, handle)` so the exit hook can
release it even though no identity was ever published (FE-R3-4c). On
`Bound`/`AlreadyBoundToCaller` →
`authorize_terminal_identity` (live-owner first, self-exempt — FE-R3-6) →
`registry.publish_running_session_identity` with the expected previous id →
synchronous `publish_terminal_identity_memory(Live)` in its callback → on
`Published`, store the token on the row
(`registry.store_admission_token`, FE-R3-4b), awaited
`persist_terminal_identity(…, Discovery)` (binding first, then
epoch-guarded pending delete) → announce `Associated` with
`previous_session_id`. **Rollback (FE-R3-4a):** if authorization rejects,
or publication returns `Missing`/`NotRunning`/`ModeMismatch`/
`ConflictingIdentity`, and this call's claim was a fresh `Bound`, the
helper releases it with `clear_binding_if_owner(&minted_token)` before
returning — the key must not stay closed for a terminal that published
nothing; an `AlreadyBoundToCaller` answer is **never** rolled back (that
binding belongs to the earlier claim). On `AlreadyPublished`: no persist,
no announce, no rollback. This closes the read-running-then-late-upsert
early-exit race and the claim-leak race. Live rebinds (codex fork,
claude/opencode signal A→B) call `rebind_discovered` instead and then run
the same pipeline; the caller replaces the row-stored token with the
returned one (FE-R3-5).

Retired algorithm (LB9): reuses authorization/durability/announcement but
publishes memory with `Retired` and calls
`registry.publish_retired_session_identity`. When the registry row is
**absent** (explicit kill removed it), a `Missing` result is **permitted**
if and only if the retained retired identity entry matches the exact
`previous_session_id` CAS; then update identity registry (retired) + ledger
only — no fabricated row, no `registry.set_meta`, no `terminal.created`, no
live activity event. Emits `associated -> changed -> retired meta`.

- [ ] **F0:** add a ws-local `RecordingSink` test double, building on Slice
  D's always-compiled `null_sink_for_tests()` no-op (the freshagent fake is
  `#[cfg(test)] pub(crate)` and invisible to `freshell-ws`, so it cannot be
  reused directly). Commit
  `test(ws): recording identity sink test double`.
- [ ] **F1 (OpenCode locator):** RED — land the helper stubbed to
  authorize-and-return-`Missing` plus tests
  - `fresh_opencode_launch_has_no_session_arg_and_records_pending`
    (argv has no `--session`; epoch-keyed pending marker exists)
  - `opencode_locator_discovery_uses_shared_memory_durability_and_announcement`
    (RecordingSink observes exactly
    `claim_discovered -> authorize(ProviderDiscovered) -> publish_memory ->
    persist(Discovery) -> announce(Associated)`, and the minted token was
    stored on the row — FE-R3-4b)
  - `opencode_discovery_after_exit_publishes_nothing`
  - `discovery_claim_rolls_back_when_terminal_exits_between_claim_and_publish`
    (FE-R3-4d claim-vs-exit race: stage the claim to succeed, then
    `finish_pty_exit` before publication; `NotRunning` → the helper clears
    the freshly minted binding and a subsequent claim on the key acquires)
  - `discovery_rejection_rolls_back_a_freshly_minted_claim` (FE-R3-4a:
    authorization rejects after a fresh `Bound`; the key reopens; an
    `AlreadyBoundToCaller` fixture variant is NOT rolled back)
  - `opencode_discovery_rejects_live_fresh_agent_owner`
  - `refused_discovery_broadcasts_session_collision_frame_and_invariant_log`
    (FE-R3-1: the refusal arm emits exactly one
    `session.collision.detected` frame on the bus and the
    `discovered_session_collision_refused` ERROR with
    `target: "invariant"`; the returned hold handle is stored on the row)
  - `refused_terminal_exit_releases_its_stored_conflict_hold` (FE-R3-4c:
    drive the refused terminal to exit; its exit hook presents the stored
    `ConflictHoldHandle` and — with the owner's binding already cleared —
    the key frees)

  GREEN — implement the helper (including the FE-R3-4 rollback/storage
  paths); add `session.collision.detected` to
  `EXTENSION_SERVER_MESSAGE_TYPES` with its shape-pin test (FE-R3-1);
  migrate the locator write tail (replace
  `identity.upsert` / `registry.set_meta` / `ledger_resolve_identity` /
  `broadcast_terminal_session_associated`) keeping `OpencodeLocator::arm`,
  `note_submit`, `tick`, root resolution, and single-bind rules unchanged.

```bash
cargo test -p freshell-ws opencode_association::tests -- --nocapture
cargo test -p freshell-ws terminal_identity_publication -- --nocapture
cargo test -p freshell-ws --test opencode_switch_rebind
git add crates/freshell-ws/src/terminal_identity_publication.rs crates/freshell-ws/src/opencode_association.rs crates/freshell-ws/src/lib.rs crates/freshell-protocol/src/server_messages.rs
git commit -m "refactor(ws): opencode discovery publishes through the shared sink"
```

- [ ] **F2 (Codex discovery/fork):** RED — add a RecordingSink assertion to
  the existing green pins
  (`codex_association::tests::drain_and_associate_binds_identity_ledger_and_broadcasts`,
  `--test codex_fork_rebind`) — the new assertion fails at runtime while the
  old fan-out bypasses the sink — plus the new admission-transfer test
  `codex_fork_rebind_frees_the_old_session_key_and_protects_the_new`
  (FE-R3-5: after a fork rebind A→B, a claim on A acquires while a claim
  on B answers `BoundLive`; the row-stored token is B's). GREEN — migrate
  the write tail through the helper, route first adoption through
  `claim_discovered` and the **fork rebind through `rebind_discovered`
  with the row-stored token, storing the returned token** (replacing the
  check-only `codex_claim_refused` fresh-agent arm as the authoritative
  gate; the diagnostics stay), keep rollout lineage, fork watch,
  `previousSessionId`, and the activity-hub calls
  (`hub.bind_codex_session` / `attach_codex_rollout`) after a successful
  publish.

```bash
cargo test -p freshell-ws codex_association::tests -- --nocapture
cargo test -p freshell-ws --test codex_fork_rebind
git add crates/freshell-ws/src/codex_association.rs crates/freshell-ws/src/codex_identity.rs
git commit -m "refactor(ws): codex discovery and fork rebind publish through the shared sink"
```

- [ ] **F3 (signal rebinds, LB9):** RED —
  `opencode_retired_signal_rebind_stays_retired_and_announces_layout_identity`,
  `retired_rebind_with_absent_registry_row_uses_retained_identity_cas`, and
  `signal_switch_rebind_transfers_the_admission_binding_atomically`
  (FE-R3-5: a live A→B signal switch goes through `rebind_discovered` —
  afterwards A is reopenable, B is protected, and the row-stored token is
  B's; retired-lane rebinds, where no live binding exists, skip the
  admission transfer) fail at runtime against the stub. GREEN — route
  OpenCode and Claude signal
  rebind tails through the shared publishers (live switches via
  `rebind_discovered`, storing the returned token), preserving guard
  ladders,
  Claude's no-first-bind-via-signal policy, OpenCode first-bind arbitration,
  retired re-retire behavior, act/retain/discard decisions, and the
  previous-session field.

```bash
cargo test -p freshell-ws opencode_signal::tests -- --nocapture
cargo test -p freshell-ws claude_signal::tests -- --nocapture
cargo test -p freshell-ws --test claude_session_rebind
cargo test -p freshell-ws --test opencode_switch_rebind
git add crates/freshell-ws/src/opencode_signal.rs crates/freshell-ws/src/claude_signal.rs crates/freshell-ws/src/terminal_identity_publication.rs
git commit -m "refactor(ws): signal rebinds publish through the shared retired-aware lane"
```

- [ ] **F4 (WS known creates):** RED — a new RecordingSink ordering test on
  the WS create path fails while WS still uses its separate post-create
  upsert/binding/pending/announcement. GREEN — same fresh-Claude predicate
  and provider candidate policy as REST; `registry.create_with_publication`
  + held finalization guard + shared post-spawn durability + existing origin
  `terminal.created` + shared `Created` announcement; exit hook passes
  `NaturalExit` (completion dropped); `handle_kill` switches to
  `retire_terminal_identity(id, ExplicitClose)` backed by
  `retire_closed_if_owned` **and awaits the returned
  `TerminalRetirementCompletion` before completing (FE-R2-8 — preserving
  today's awaited `spawn_blocking` retirement, `terminal.rs:3880-3903`),**
  with RED test `handle_kill_awaits_ledger_retirement_before_completing`
  (barrier-gated ledger: the kill handler must not finish while the
  retirement job is still blocked). Do not change request-id dedupe,
  attach/adopt branches, or provider launch arguments. Auto-resume pins
  must stay green (LB7 + drift constraint: no interference with
  `auto_resume_cancels` or settle frames).

```bash
cargo test -p freshell-ws ws_known_create_publishes_through_shared_sink -- --nocapture
cargo test -p freshell-ws handle_kill_awaits_ledger_retirement_before_completing -- --nocapture
cargo test -p freshell-ws --test session_identity_frames
cargo test -p freshell-ws --test live_session_ref_guard
cargo test -p freshell-ws --test pane_ledger_triggers
cargo test -p freshell-ws --test auto_resume_e2e -- --nocapture
git add crates/freshell-ws/src/terminal.rs
git commit -m "refactor(ws): share known-create terminal identity publication"
```

- [ ] **F5 (deferred re-authorization, LB12/FE6/FE7/FE-R2-6):** RED — the
  five declared tests (FE-R2-12: this list is exhaustive and every focused
  command below names one of them exactly):

  1. `unknown_legacy_resume_authorizes_late_and_publishes_via_discovered_pipeline`
     (fake existence probe answers `Unknown`, terminal launches with a
     deferred marker, probe flips to fresh `Present`, worker publishes;
     assert `associated -> changed -> meta` and the published
     `ExistenceValidatedLegacyResume` identity. **This fixture inherently
     exercises FE-R3-6 and FE-R3-2:** the candidate's own row is Running
     with `resume_session_id == candidate` the whole time — authorization
     must not reject itself (self-exempting live-owner join) — and the
     worker's `claim_discovered` presents the terminal's create-time
     `BoundOwner` token, answering `AlreadyBoundToCaller` (idempotent
     re-publication), which the test asserts explicitly)
  2. `stale_absent_defers_then_fresh_absent_drops_permanently` (fake probe:
     `Absent`+stale → marker retained and requeried; `Absent`+fresh →
     marker dropped with a structured warning)
  3. `fresh_absent_and_provider_unavailable_are_never_deferred`
  4. `fresh_unknown_answers_continue_the_bounded_requery` (FE-R2-6: the
     fake probe answers `Unknown` with `index_fresh: true` — the warm-index
     OpenCode `Unreadable → Unknown` shape — for three attempts, then fresh
     `Present`; the worker must NOT stop on the fresh `Unknown`s and must
     publish on the `Present`)
  5. `requery_exhaustion_drops_marker_with_structured_warning` (the fake
     probe never answers conclusively — stale answers and/or fresh
     `Unknown`s through all 8 attempts; assert the marker is dropped with
     the structured warning and nothing publishes)

  All five fail against the stub worker. GREEN — implement the **bounded
  fresh-answer requery worker** in `terminal_identity_publication.rs` over
  the sink's deferred markers, exactly per "Deferred re-authorization"
  (capped backoff, ≤ 8 attempts, stop on the first **conclusive** fresh
  answer — fresh `Unknown` continues (FE-R2-6) — drop-with-warning on
  exhaustion; the fake probe drives the schedule deterministically via
  injected clock/attempt hooks — no sleeps); markers dropped on exit.

```bash
cargo test -p freshell-ws unknown_legacy_resume_authorizes_late_and_publishes_via_discovered_pipeline -- --nocapture
cargo test -p freshell-ws stale_absent_defers_then_fresh_absent_drops_permanently -- --nocapture
cargo test -p freshell-ws fresh_absent_and_provider_unavailable_are_never_deferred -- --nocapture
cargo test -p freshell-ws fresh_unknown_answers_continue_the_bounded_requery -- --nocapture
cargo test -p freshell-ws requery_exhaustion_drops_marker_with_structured_warning -- --nocapture
cargo test -p freshell-ws --all-targets
cargo fmt --all --check
cargo clippy -p freshell-ws -p freshell-server --all-targets -- -D warnings
git add crates/freshell-ws/src/terminal_identity_publication.rs crates/freshell-ws/src/identity_sink.rs
git commit -m "feat(ws): deferred re-authorization for cold-index legacy resumes"
```

  Refactor pass after F5: delete the superseded duplicated broadcaster and
  `ledger_resolve_identity` helper if no call sites remain; no parallel
  paths.

---

### Slice G — `/api/terminals` authority-only projection + read-model alignment

Deliberately **after** E2 + F so every authoritative publisher is wired (the
projection removal's own precondition), and with D1's carve-out encoded.

**Files:** `crates/freshell-server/src/terminals.rs`,
`crates/freshell-ws/src/reconcile.rs`.

- [ ] **Step 1 (RED):**
  `directory_does_not_invent_session_ref_from_unpublished_resume_session_id`
  (compiles today, fails at runtime): live `opencode` row with
  `resume_session_id = "ses_unverified"`, empty identity registry, assert
  `item.get("sessionRef").is_none()`. Plus behavior pins that land green:
  `directory_still_synthesizes_gemini_and_kimi_session_refs` (D1 carve-out)
  and the two existing codex projection pins (`terminals.rs:1237,1269`).

```bash
cargo test -p freshell-server terminals::tests::directory_does_not_invent_session_ref_from_unpublished_resume_session_id -- --exact --nocapture
```

- [ ] **Step 2 (GREEN):** replace the synthesis block
  (`terminals.rs:686-698`) with: `gemini`/`kimi` → existing
  `mode + resume_session_id` synthesis retained verbatim; every other mode →
  identity-registry-only projection
  (`state.identity.session_ref_for(&e.terminal_id)`). No pane payload
  promotion here.
- [ ] **Step 3 (LB11, RED then GREEN):** in `reconcile.rs`, scope the
  promoted-claim echo: for claude/codex/opencode/amplifier,
  `verdict_for_pane` no longer echoes an unpublished promoted claim as the
  pane's `session_ref` (`.or_else(|| Some(claim.clone()))` becomes
  gemini/kimi-only); the registry-row join for pane→terminal attachment is
  untouched (launch-fact consumer). Tests:
  - `unpublished_four_provider_claim_is_not_echoed_as_pane_session_ref`
  - `gemini_kimi_promoted_claim_echo_is_preserved`
  - One-key regression at the read-model level:
    `legacy_unknown_resume_yields_one_sidebar_key_shape` — server-side
    fixture proving the pane payload and directory row cannot disagree
    (pane: no `session_ref`; directory: no `sessionRef`; the client's
    synthetic `provider:terminal:<id>` key is then the only key — pinned by
    the existing selector test
    `sidebarSelectors.runningTerminal.test.ts`, which stays untouched).
- [ ] **Step 4 (verify + commit):**

```bash
cargo test -p freshell-server terminals::tests -- --nocapture
cargo test -p freshell-ws reconcile -- --nocapture
npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/store/selectors/sidebarSelectors.knownKeys.test.ts
cargo fmt --all --check
cargo clippy -p freshell-server -p freshell-ws --all-targets -- -D warnings
git add crates/freshell-server/src/terminals.rs crates/freshell-ws/src/reconcile.rs
git commit -m "fix(server): project only published identity for the four providers"
```

---

### Slice H — Ordered REST announcement enqueue + client regression

**Files:** `crates/freshell-freshagent/src/terminal_tabs.rs`,
`test/unit/client/components/App.ws-bootstrap.test.tsx`. Do not modify
`src/store/selectors/sidebarSelectors.ts`.

All ordering language here is **enqueue order on the broadcast bus before
the HTTP handler returns**, observed by a test subscriber. Browser
observation order is explicitly not claimed; handshake-inventory resync is
the recovery invariant (see Global Constraints).

- [ ] **Step 1 (RED):** four server order tests (route currently emits only
  `ui.command`):
  - `ordinary_rest_create_enqueues_ui_changed_meta_before_returning`
    (`frame_types == ["ui.command","terminals.changed","terminal.meta.updated"]`)
  - `deferred_rest_create_enqueues_changed_meta_without_broadcasting_ui`
    (command in the HTTP body only)
  - `identityless_create_emits_changed_without_meta`
  - `degraded_durability_emits_exactly_one_warning_and_one_invalidation_sequence`
    (HTTP 200 + exactly one `durability.degraded`, typed reason, never two
    frames)

```bash
cargo test -p freshell-freshagent terminal_tabs::tests::ordinary_rest_create_enqueues_ui_changed_meta_before_returning -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::deferred_rest_create_enqueues_changed_meta_without_broadcasting_ui -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::identityless_create_emits_changed_without_meta -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::degraded_durability_emits_exactly_one_warning_and_one_invalidation_sequence -- --exact --nocapture
```

  (All four declared tests are run focused — no declared/run drift.)

- [ ] **Step 2 (GREEN):** implement via the **two-phase settle handoff with
  a phase-one result channel** (FE-R3-8, exactly per Lifecycle
  Corrections — this is how "the settle task holds the guard through
  announcement" coexists with "the route builds `ui.command` after it
  learns the spawn result" and with the no-lower-helper-announcement
  rule, without the circularity of awaiting the settle `JoinHandle`):
  after durable settlement the settle task sends the creation result over
  `result_tx` **without finishing** and awaits `announce_rx`;
  `spawn_terminal_pane` returns the phase-one result plus the
  `{announce_tx, ack_rx}` handle instead of `settle.await`;
  `create_terminal_tab`, after its pane/tab bookkeeping and `ui.command`
  construction, sends its `AnnouncementPlan` and awaits the enqueue ack
  before returning (this is what makes the Step 1 enqueue-before-return
  assertions pass); the settle task re-checks the row is still Running
  (FE-R3-10), enqueues
  `ui.command -> terminals.changed -> terminal.meta.updated` in order,
  acks, then drops the finalization guard and finishes. Deferred delivery
  sends a no-`ui.command` plan and returns the command in the body. Every
  dropped sender (client abort at any point; settle panic before the
  phase-one send → route 500) resolves deterministically per Lifecycle
  Corrections — no timeouts (tested in Slice E2). Split/respawn callers
  use the same handoff after their UI command; the lower spawn helper
  itself never announces.
- [ ] **Step 3 (client regression):** in `App.ws-bootstrap.test.tsx`, with
  the real store/handler/thunk/reducer/selector/rendered Sidebar, seed the
  exact incident (`sessionId = '019f9cb3-…'`,
  `terminalId = '8f673dee-…'`): one open `gf ui` pane with the canonical
  ref + a cached revision-1700 identityless directory row; precondition
  keys `["codex:<sid>", "codex:terminal:<tid>"]`; deliver
  `terminals.changed{revision:12}` then the canonical
  `terminal.meta.updated`; mock the one debounced
  `GET /api/terminals?priority=visible&revision=1700` with the canonical
  ref; after the real debounce assert one directory request, keys
  `["codex:<sid>"]`, one `gf ui` button, and same-revision replacement of
  the stale row.
- [ ] **Step 4 (adverse interleaving, LB17):** second client test — apply the
  HTTP create response **before** delivering the frames (the un-guaranteed
  browser order), assert bounded transient duplication and **eventual
  convergence to one key** once frames/refetch land.
- [ ] **Step 5 (collision alarm client surface, FE-R3-1):** consume
  `session.collision.detected` in `src/lib/terminal-invalidation-handler.ts`
  (its `handle()` already branches on loosely-typed `msg.type`,
  `terminal-invalidation-handler.ts:85,108` — no schema change needed for
  an extension frame) and surface it as a visible, dismissable alarm via a
  new `SessionCollisionBanner` component following the existing banner
  precedents (`ReconcileWarmingBanner.tsx`, `TerminalExitBanner.tsx`),
  naming the provider/session and both writers. RED first:
  `session_collision_frame_surfaces_a_visible_alarm` in
  `test/unit/client/lib/terminal-invalidation-handler.test.ts` (handler
  dispatch half) plus a rendered-banner assertion in the component test.
  No selector change.
- [ ] **Step 6 (verify + commit):**

```bash
cargo test -p freshell-freshagent terminal_tabs::tests -- --nocapture
npm run test:vitest -- run test/unit/client/components/App.ws-bootstrap.test.tsx
npm run test:vitest -- run test/unit/client/lib/terminal-invalidation-handler.test.ts
npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.test.ts
cargo fmt --all --check
cargo clippy -p freshell-freshagent --all-targets -- -D warnings
git add crates/freshell-freshagent/src/terminal_tabs.rs test/unit/client/components/App.ws-bootstrap.test.tsx \
  src/lib/terminal-invalidation-handler.ts src/components/SessionCollisionBanner.tsx \
  test/unit/client/lib/terminal-invalidation-handler.test.ts
git commit -m "fix(client): invalidate REST terminal identity in order and surface session collisions"
```

---

### Slice I — Merged integration, real-provider, and browser acceptance

Acceptance pins over already-green behavior — green-on-land is correct here;
no red phase required.

**Files:** create `crates/freshell-ws/tests/rest_terminal_identity.rs`;
modify `test/integration/real/coding-cli-session-contract.test.ts`; create
`test/e2e-browser/specs/rest-terminal-identity-rust.spec.ts`; modify
`test/e2e-browser/playwright.config.ts` (register the new Rust-only spec —
FE-R2-13).

- [ ] **Step 1:** merged-server harness reusing the
  `rest_ws_shared_gate.rs` listener/router pattern and the real-ledger state
  pattern from `tests/common/mod.rs`, importing the **production**
  `freshell_ws::identity_sink::LedgerIdentitySink` (LB18 resolved by
  Slice D). Recording executables for all four providers; every root under
  one `TempDir`.
- [ ] **Step 2:** the exact incident test
  `gf_ui_rest_recovery_is_one_process_one_identity_one_sidebar_key`
  (`multi_thread` flavor): seed the old `981008-old-gf-ui` binding, POST the
  exact incident create (`gf ui`, codex,
  `019f9cb3-f11e-79f3-a968-287a5bc5798c`), then assert one process
  invocation, one tab/pane, and new row + identity registry + live ledger +
  fresh-`PaneLedger` reload all naming the exact Codex ref, with ordered
  changed/meta frames **enqueued before the response completes**
  (test-subscriber observation). **Provenance scoping (FE-R3-13):** neither
  the identity-registry entry (`TerminalIdentity`,
  `crates/freshell-ws/src/identity.rs:34-46`) nor the persisted
  `BindingRow` (`crates/freshell-ws/src/pane_ledger.rs:93-129`) stores
  provenance, and this plan deliberately adds **no persistence schema
  change** for it — so this test asserts only observable persistence facts
  (rows exist, sessionRef exact); the `AcceptedSessionRef` provenance for
  this shape is asserted at the typed seams (the fake sink's recorded
  `AuthorizedTerminalIdentity` in Slice E2's route tests and the ws
  authorize unit tests in Slice D). **Expected GREEN
  on first run** — the incident fix landed in #584 (see Reconciliation);
  this is a permanent acceptance pin that additionally covers what the
  landed pins don't (enqueue order, ledger reload), not a red
  phase.
- [ ] **Step 3:** provider matrix (`multi_thread`):
  - `explicit_refs_publish_for_all_four_terminal_providers` (per provider:
    directory projection, identity registry, live ledger, and a
    fresh-`PaneLedger` reload all equal the request ref — this carries the
    reloaded-production-ledger assertion that E2's freshagent unit seam
    cannot host, FE-R3-14)
  - `fresh_claude_is_preallocated_and_restart_durable`
  - `fresh_amplifier_is_prestubbed_preallocated_and_restart_durable`
  - `fresh_opencode_binds_only_after_locator_discovery` (no `--session` in
    argv; pending marker before tick; `associated -> changed -> meta` after
    a provider-owned SQLite root session appears)
  - `live_fresh_agent_ownership_blocks_terminal_resume_for_each_runtime_provider`
  Restart tests construct a new ledger from `ledger_root`; no claim that a
  live PTY survives process death.
- [ ] **Step 4:**

```bash
cargo test -p freshell-ws --test rest_terminal_identity -- --nocapture
```

- [ ] **Step 5 (real OpenCode contract):** under
  `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`, isolated OpenCode home; random
  `ses_freshell_preallocated_*` id must fail with `Session not found`; a
  provider-owned session remains attachable via `--session`. Record the
  detected version; skip only through the suite's provider-unavailable
  mechanism.
- [ ] **Step 6 (Amplifier contract, LB20 — pinned):** the validated contract
  version is **amplifier CLI `2026.07.13-51194ef` / core `1.6.0`**: the real
  CLI adopts a broker-shaped pre-created stub under the cwd slug, preserves
  `metadata.json` (`session_id`, `freshell_terminal_id`), and leaves
  `turn_count` unset on zero-turn adoption
  (`test/integration/real/amplifier-stub-adoption-contract.test.ts`,
  fully HOME-sandboxed). **Note:** the second test ("creates its own session
  dirs under exactly our computed slug, with turn_count") is gated on a
  provider API key and was **skipped** in validation — never read that skip
  as coverage; the slug contract is proven only implicitly by adoption. Run
  it opportunistically when a key is present; a future amplifier release
  changing adoption/rejection semantics must stop the work and be reported
  as a provider contract change.

```bash
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/coding-cli-session-contract.test.ts --config config/vitest/vitest.server.config.ts
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/amplifier-stub-adoption-contract.test.ts --config config/vitest/vitest.server.config.ts
```

  (Both commands need `--config config/vitest/vitest.server.config.ts` —
  the default `config/vitest/vitest.config.ts` **excludes**
  `test/integration/real/**`, so without it the run selects nothing and
  passes vacuously — FE-R2-14 and the FE-R2-11 zero-selection rule.)

- [ ] **Step 7 (browser E2E):** one Rust-only Playwright spec using the fake
  provider fixtures and scratch-server conventions from
  `pane-ledger-restart-rust.spec.ts`: exact `gf ui` Codex resume → one
  sidebar row + one process-log entry; fresh Claude (`--session-id <uuid>`);
  fresh Amplifier (stub before start receipt); fresh OpenCode (no
  `--session`, locator materialization, one canonical row); spec-owned
  scratch restart; restored panes resume with the durable ids. Never
  reference port 3002. **Register the spec in
  `test/e2e-browser/playwright.config.ts` in BOTH lists (FE-R2-13):** add
  `/rest-terminal-identity-rust\.spec\.ts$/` to the `rust-chromium`
  project's `testMatch` allowlist (the additions block after
  `MATRIX_SPECS`, config line ~216) — without this the
  `--project=rust-chromium` run below selects nothing and passes vacuously
  (the FE-R2-11 rule applies: verify the Playwright summary shows the
  spec's tests actually ran) — **and** to the `RUST_ONLY_SPECS` list
  (config line ~81) so the default `chromium` project's `testIgnore` (and
  every match-all project) never picks up a spec whose
  `e2eServerKind: 'rust'` guard fails under the fixture-default `legacy`.

```bash
npm run test:e2e -- test/e2e-browser/specs/rest-terminal-identity-rust.spec.ts --project=rust-chromium
```

- [ ] **Step 8 (Commit):** after GREEN, extract shared harness helpers into
  `crates/freshell-ws/tests/common/mod.rs` only if at least two test files
  use identical code; rerun Steps 4/6/7.

```bash
git add crates/freshell-ws/tests/rest_terminal_identity.rs \
  test/integration/real/coding-cli-session-contract.test.ts \
  test/e2e-browser/specs/rest-terminal-identity-rust.spec.ts \
  test/e2e-browser/playwright.config.ts
git commit -m "test(identity): cover REST provider identity matrix"
```

(Add `crates/freshell-ws/tests/common/mod.rs` to the `git add` only if it
changed.)

---

### Slice J — Whole-branch verification, review, and handoff

Verify only. Fix branch-caused failures with focused tests and focused
commits.

- [ ] **Step 1 (focused regressions):**

```bash
cargo test -p freshell-terminal session_admission -- --nocapture
cargo test -p freshell-terminal registry::tests -- --nocapture
cargo test -p freshell-freshagent identity_sink::tests -- --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests -- --nocapture
cargo test -p freshell-ws identity_sink::tests -- --nocapture
cargo test -p freshell-ws --test cross_kind_admission -- --nocapture
cargo test -p freshell-ws --test rest_terminal_identity -- --nocapture
cargo test -p freshell-ws --test auto_resume_e2e -- --nocapture
cargo test -p freshell-server identity_sink::tests -- --nocapture
cargo test -p freshell-server terminals::tests -- --nocapture
npm run test:vitest -- run test/unit/client/components/App.ws-bootstrap.test.tsx
npm run test:vitest -- run test/unit/client/lib/terminal-invalidation-handler.test.ts
npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.test.ts
```

- [ ] **Step 2 (Rust gates):**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings
cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings
cargo test --workspace --all-targets
```

- [ ] **Step 3 (contract/JS gates, via the shared test coordinator):**

```bash
npm run test:port
npm run contract:generate
git diff --exit-code -- port/contract
cargo test -p freshell-protocol --locked
npm run test:status
FRESHELL_TEST_SUMMARY='verify unified terminal identity publication' npm run check
npm run lint
```

  Expected protocol deltas, exactly two: the
  `SessionRefClaim::OwnedByFreshAgent` server-internal variant, and the
  `session.collision.detected` **extension-lane** frame (FE-R3-1) — added to
  `EXTENSION_SERVER_MESSAGE_TYPES` (`server_messages.rs:211-221`), which is
  declared *beyond* the generated inventory, so `npm run contract:generate`
  must show **no** drift for it (its shape is pinned by a Rust test
  instead). The existing `durability.degraded`, `terminals.changed`,
  `terminal.session.associated`, `terminal.meta.updated`, and
  `ProtocolMismatch` surfaces are reused. If contract generation shows any
  drift, stop and report before regenerating.

- [ ] **Step 4 (browser acceptance):**

```bash
npm run test:e2e -- test/e2e-browser/specs/rest-terminal-identity-rust.spec.ts --project=rust-chromium
```

- [ ] **Step 5 (scope audit):**

```bash
git status --short
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
git log --oneline --decorate origin/main..HEAD
```

  Require: no selector change; no Node server change; no OpenCode
  preallocation; no provider launch-policy drift beyond the documented LB15
  legacy-restub change and D5 removal; no gemini/kimi behavior change; no
  production/evidence artifacts; no uncommitted changes; no port-3002
  action.

- [ ] **Step 6 (reviews):** broad code review over `origin/main...HEAD`; fix
  actionable findings; rerun covering tests. Then Fresh Eyes on the complete
  delta up to five rounds or until pass, committing fixes between rounds.
  If the fifth round fails, report loudly and do not claim readiness.
- [ ] **Step 7 (report + stop):** do not push unless asked; no PR, merge,
  deploy, restart, or worktree removal. Report:

  - worktree, branch, base SHA (current `origin/main` at implementation
    start — `c5e9fdaa` as of this revision), head SHA, and the fresh
    baseline evidence from Preflight
  - focused commits per slice
  - `gf ui` green-pin evidence (Slice I) with reference to #584's landed
    pins (`rest_locator_identity.rs`, `rest_claude_identity.rs`) — there is
    no RED tuple anymore; the incident fix landed in #584
  - binder-absorption evidence (FE3): `pane_identity_binder.rs` and the
    trait deleted, ported unit tests green, landed integration pins green,
    and any deliberately rescoped raw-id-authority pin recorded as a delta
  - publisher-abort subprocess test evidence (FE1) and the
    registry-usable-after-error evidence
  - client-abort settlement evidence (FE9:
    `client_abort_mid_create_still_completes_settlement`)
  - the FE10 rejection-ladder evidence (400 provider mismatch, 422
    unresolved claude restore, amplifier restore-bare carve-out pin)
  - cross-kind admission barrier-test evidence (exactly-one-winner for
    claude/codex/opencode on both doors, both orders, with **exact** loser
    error codes for both cross-kind and same-kind contention — FE-R2-3) —
    reported with the honest invariant wording (admission prevention +
    alarmed discovered-collision exposure, D3-clarified; never "two writers
    can never share a session") — plus the `auto_resume`
    `OwnedByFreshAgent` refusal test (FE4),
    the `claim_discovered` prior-token idempotency tests (FE11/FE-R3-2), the
    epoch-token/double-clear regressions
    (`stale_epoch_clear_cannot_release_a_replacement_binding`,
    `codex_double_clear_cannot_release_a_replacement_binding` — FE-R2-1),
    the hold-epoch dedupe/stale-release tests (FE-R3-3), the
    `rebind_discovered` transfer tests (FE-R3-5), the discovery
    rollback/stored-token tests (FE-R3-4), and the poisoned-key
    conflict-hold tests
    (`poisoned_key_stays_closed_after_owner_exit_until_hold_released`,
    `poisoned_answers_carry_holder_kinds` — FE-R3-7 — and the barrier-level
    `refused_discovery_keeps_key_closed_until_refused_process_exits` —
    FE-R2-2)
  - collision alarm-surface evidence (FE-R3-1):
    `refused_discovery_broadcasts_session_collision_frame_and_invariant_log`,
    the extension-lane shape pin, and the client banner test
  - settle-handoff evidence (FE-R3-8/FE-R3-10): both client-abort drop
    points and
    `kill_during_settlement_skips_created_and_cleans_up_epoch_conditionally`
  - duplicate-id pre-reservation evidence (FE-R3-9) and the
    retirement ownership-record replacement-safety evidence (FE-R3-11)
  - amplifier claim-before-stub evidence (FE-R3-12:
    `admission_loser_never_writes_amplifier_stub`)
  - the D5 legacy-WS removal evidence (reject + plain-shell-allowed tests)
  - provider matrix outcomes; OpenCode no-preallocation evidence/version;
    pinned amplifier contract version and the key-gated skip status
  - deferred re-authorization evidence (Unknown/stale-Absent → fresh-Present
    convergence; fresh-Absent permanence; bounded-schedule exhaustion)
  - ordinary-restart ledger reload evidence
  - enqueue-order assertions and the adverse-interleaving convergence test
  - focused and broad verification commands/outcomes; review rounds
  - readiness for explicit PR approval

## Acceptance Summary

1. The exact `gf ui` Codex recovery shape — fixed on main by #584 — is
   pinned permanently green: directory, memory registry, and disk-reloaded
   ledger all name the new terminal and
   `019f9cb3-f11e-79f3-a968-287a5bc5798c`, with ordered enqueue (Slice I
   pin on top of the landed
   `rest_locator_identity.rs`/`rest_claude_identity.rs` pins); its
   `AcceptedSessionRef` provenance is asserted at the typed seams (fake
   sink + authorize unit tests — no persistence schema stores provenance
   and none is added, FE-R3-13). The
   landed provenance-blind binder is absorbed and deleted: no parallel
   identity write path remains, and legacy raw ids publish only after
   `Present` existence.
2. **Admission is atomic, and the guarantee is stated honestly
   (D3-clarified, FE-R3-1): two writers are never ADMITTED** — no
   create/attach/resume door can spawn or adopt a second writer. One
   `SessionAdmission` table admits
   terminal and fresh-agent creates; barrier-synchronized tests prove
   exactly-one-winner and exactly-one-writer for claude, codex, and opencode
   on both doors (WS and REST), in both interleaving orders, with **exact**
   per-door, per-contention-kind loser errors (cross-kind: REST 409
   `RESTORE_UNAVAILABLE`, WS `RESTORE_UNAVAILABLE` frame, fresh-agent
   `SESSION_RESERVED` retryable; same-kind WS terminal contention —
   including same-kind poisoned keys — keeps the
   existing D8 `SESSION_RESERVED` frame — FE-R2-3/FE-R3-7, distinguished
   via the exposed holder kinds). Every binding carries a table-minted
   `AdmissionEpoch` and every cleanup call presents it, so stale cleanup —
   including the codex watcher/`handle_kill` double clear — can never
   release a replacement owner's binding (FE-R2-1, regression-tested at
   table and facade level); live rebinds (codex fork, signal A→B switches)
   transfer the binding atomically via `rebind_discovered` (FE-R3-5).
   The previously deterministic REST-door two-writer hole has a direct
   regression test. No **admission** race is recorded or accepted; the
   sole documented exposure is item 3's alarmed discovered-collision
   window — the plan claims absolute two-writer prevention nowhere.
3. **Discovered collisions: refused, poisoned, alarmed — honestly bounded
   (D3-clarified).** A retroactively discovered identity that collides —
   same kind or cross kind — is refused binding atomically; the running
   process is never auto-killed (freezing/killing is out of scope); the
   refusal installs an epoch-carrying, deduped conflict hold that keeps
   the session key closed until the refused process exits
   (FE-R2-2/FE-R3-3) — the original owner's exit alone never frees a key
   a refused writer is still using (poisoned-key retry proven in the
   barrier suite) — and the alarm surface fires: the
   `discovered_session_collision_refused` invariant ERROR (the verified
   D8 alarm mechanism, `registry.rs:2377-2389`), one
   `session.collision.detected` extension frame, and the client
   `SessionCollisionBanner`. **Residual exposure, documented:** the two
   already-running writers remain attached from the newcomer's launch
   until user action closes one — bounded by the alarm, refusal of all
   further admissions, and sidebar surfacing (the refused terminal is
   never presented as the session's owner). This case is inherent to
   providers that reveal identity only after launch and is never
   described as prevented.
4. Legacy (non-negotiated) WS connections can no longer perform
   session-carrying `terminal.create` (deterministic `ProtocolMismatch`
   error instructing a refresh); plain-shell creates on legacy connections
   still work; the legacy check-then-spawn path for session-carrying creates
   is gone.
5. Fresh REST Claude mints one canonical UUID, launches with `--session-id`,
   publishes atomically, and is restart-durable via the post-spawn write.
6. Explicit matching Claude, Codex, OpenCode, and Amplifier `sessionRef`
   creates publish the exact accepted identity and correct provider resume
   argv.
7. Fresh Amplifier retains its effective-cwd, pre-stub, resume-launch, and
   stub-GC behavior; **legacy raw** Amplifier ids are existence-adjudicated
   with a probe-only lookup (ignoring zero-turn broker stubs) before any
   stub write, and the stub still precedes `registry.create`.
8. Fresh OpenCode never receives a fabricated `--session`; its discovered id
   flows through `claim_discovered` (prior-token idempotency, row-stored
   token, rollback on any post-claim failure — FE-R3-2/4) + the shared
   memory/durability/retirement/invalidation pipeline; fresh Codex adoption
   and fork/signal rebind tails use the same pipeline via
   `rebind_discovered` (FE-R3-5) without changing discovery policy.
9. A legacy raw resume id becomes authoritative only on `Present` existence
   — immediately or through deferred re-authorization (bounded fresh-answer
   requery); `Absent` from a **fresh** index and `ProviderUnavailable` are
   permanent, while `Unknown` and stale-snapshot `Absent` defer (FE6/FE7); a
   live owner refuses the launch before existence is even consulted. Invalid
   REST create shapes are rejected before spawn: 400
   `SESSION_REF_PROVIDER_MISMATCH` for a cross-provider ref, 422
   `CLAUDE_RESTORE_UNRESOLVED` for an unresolvable claude restore (FE10);
   the amplifier restore-bare carve-out is pinned as deliberate.
10. `/api/terminals` projects `sessionRef` only from the shared identity
    registry for claude/codex/opencode/amplifier, and retains the documented
    `mode + resume_session_id` synthesis for gemini/kimi (D1). Reconcile no
    longer echoes unpublished promoted claims for the four providers, so a
    legacy-unknown restore yields exactly one sidebar key.
11. A terminal registry row and its in-memory identity are never observably
    split; duplicate terminal ids are rejected by **pre-reservation before
    any PTY exists**, so a rejected create can never spawn an orphan whose
    exit hook corrupts the pre-existing terminal (FE-R3-9); the exit hook
    cannot run before create settlement completes (the
    settlement-owner-held finalization guard opens on every success, error,
    and unwind path, proven by duplicate-id and client-abort tests, and on
    the REST door the guard lives in the detached settle task, which
    re-checks the row is still Running before announcing — a kill landing
    mid-settlement yields no `Created`/`ui.command`, FE-R3-10); the
    publication callback is panic-free by construction and a publisher
    unwind **aborts the process** rather than poisoning the registry (FE1,
    proven by the subprocess abort test); a discovery/exit race cannot
    resurrect stale identity or leak an admission claim (FE-R3-4).
12. Durable rows become `Closed` only on explicit user kill — the WS
    `terminal.kill` door exclusively (FE8; no REST close/kill door exists or
    is added), and `handle_kill` **awaits** the retirement completion before
    completing, preserving today's awaited ledger retirement (FE-R2-8);
    epoch-keyed pending markers are deleted on **every** exit cause
    (FE-R2-7 — the landed binder's natural-exit pending cleanup is
    preserved); natural exit, auto-resume settlement, and graceful shutdown
    leave rows `Bound` (auto-resume e2e pins stay green); all delayed
    cleanup is epoch-conditional, resolves its expected values from the
    sink's publication-time ownership record — never from live state
    (FE-R3-11) — and cannot erase a replacement owner; the
    retired OpenCode missing-row rebind lane still works after explicit
    kill.
13. Enabled writes reload after an ordinary restart. Disabled ledger, I/O
    failure, and blocking-task failure are typed degradations, preserve
    success, and emit exactly one live warning per identity event.
14. One pointer-identical sink is wired into all five consumers and asserted
    at boot (`identity_sink_wired()` + `Arc::ptr_eq`); a set failure is loud;
    the owner probes hold weak references and the teardown test proves no
    Arc cycle.
15. Ordinary REST delivery enqueues `ui -> changed -> meta` and deferred
    delivery enqueues `changed -> meta` before the HTTP handler returns
    (enqueue claims only); the adverse-interleaving client test proves
    eventual one-key convergence; handshake-inventory resync is the
    documented recovery invariant.
16. Focused, workspace, contract, lint, coordinated JS, and Rust-browser E2E
    gates pass on the fresh baseline taken on current `origin/main` at
    implementation start (`c5e9fdaa` as of this revision); the landed #584
    pins
    (`rest_claude_identity.rs`, `rest_locator_identity.rs`,
    `pane_ledger_restore.rs`) stay green (with any deliberate raw-id
    rescope recorded); the `PaneIdentityBinder` module/trait/wiring are
    gone; all changes remain committed locally, undeployed, and without a
    PR.
