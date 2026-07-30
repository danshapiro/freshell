# Unified Terminal Session Identity Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision note:** This is the post-validation rewrite. All twenty load-bearing
> assumptions were validated (groups G1–G5). Six lifecycle assumptions were
> falsified, the cross-runtime admission race was confirmed as a deterministic
> production hole on the REST door, and the original task sequence was proven
> non-executable. This revision encodes every validator-required correction and
> five explicit user product decisions. Do not resurrect the previous revision's
> lifecycle semantics, residual-race language, or task ordering.

**Goal:** Give every authoritative terminal session identity—accepted resume,
server-preallocated fresh identity, provider-discovered identity, or
existence-validated legacy resume—one provider-aware publication pipeline that
atomically joins the terminal row to the shared identity registry, records the
pane ledger durably, retires it correctly by exit cause, and enqueues ordered
client invalidations; and make cross-kind (terminal vs fresh-agent) session
admission a single atomic claim so two writers can never open one provider
session file.

**Architecture:** Take over and generalize the existing
`PaneIdentitySink`/`LedgerIdentitySink` design instead of adding the separate
`PaneIdentityBinder` proposed by the Claude-only plan. Provider policy produces
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
controller-cache failure, or filesystem corruption. There are no pre-spawn
ledger writes in this design (see Lifecycle Corrections, LB5).

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
- **D3 (LB14) — Never auto-kill on retroactive collision.** When a fresh
  Codex/OpenCode terminal discovers a session id already owned by a
  fresh-agent pane (or vice versa), leave the running process alone, refuse
  the binding atomically, emit a loud user-visible error and an
  invariant-level log. No automatic kill.
- **D4 (LB14) — The REST-door two-writer hole is fixed early in this
  branch.** The `SessionAdmission` extraction and REST-door protection are
  sequenced as Slice B0, before every publication slice, so the deterministic
  corruption hole on current `origin/main` closes first. No separate hotfix
  PR.
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
- **Standing constraints (already in force):** no acceptance of any residual
  two-writer window anywhere in this plan or its report; tests use fake
  provider homes and temp directories only; never touch port 3002 or the
  preserved evidence bundle; no PR until the user explicitly approves one.

## Out of Scope

- Any Gemini/Kimi identity-model change beyond preserving today's behavior
  (deprecation is kata `jb4z`).
- Redirect-the-loser-to-the-existing-pane UX (D2 chose refusal).
- Any policy that kills a running provider process on a discovered-identity
  collision (D3 chose leave-running + loud error).
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
| LB4 gate on error/unwind | Inconclusive → must design | Slice B (guard-on-drop, duplicate-id, panic tests) |
| LB5 pre-spawn Bound window | Falsified | No pre-spawn ledger writes (decision below) |
| LB6 exit races settlement | Falsified | Slice B (caller-held finalization guard) |
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

## Global Constraints

- Work only in
  `/home/dan/code/freshell/.worktrees/rest-codex-terminal-identity` on branch
  `fix/rest-terminal-identity-publication`, now rebased onto `origin/main`
  `537d7d09`.
- **Preflight baseline (required before Slice A):** the previously recorded
  9,585-pass baseline was run on the stale base `4c04dc9c` and proves nothing
  about `537d7d09`. Before any implementation commit, run the repo-supported
  baseline on the current base per `AGENTS.md` (broad suites go through the
  shared test coordinator; never kill a foreign holder), record the result,
  and stop if the base is not green.
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
  accepted residual race; the barrier tests in Slice B0 are the gate.
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
  caller's settlement (provider adoption, durable write, announcement
  enqueue) completes; the caller holds a finalization guard whose drop —
  on every success, error, and unwind path — releases the exit hook. A
  locator result racing with exit cannot publish identity to a missing or
  non-running terminal.
- **Exit-cause discipline:** durable ledger rows become `Closed` only on
  explicit user close. Natural PTY exit, auto-resume settlement, and graceful
  shutdown leave rows `Bound`. In-memory identity is marked retired (retained,
  not deleted) on every exit so the trusted retired-signal lane keeps working.
  New exit machinery must not race or suppress the current
  `auto_resume_cancels`/settle-frame behavior.
- **Epoch-conditional cleanup:** every delayed mutation (ledger retire,
  pending delete, admission binding clear) carries the owning terminal id
  (and create-request id where available) and mutates only if it still owns
  the row/key. Never let old cleanup erase a replacement owner.
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
| Fresh Claude | Freshell UUID | `Start`, `--session-id <uuid>` | `ServerPreallocated` | Post-spawn awaited write | `terminals.changed`, then `terminal.meta.updated` |
| Explicit Claude `sessionRef` | Accepted matching ref | `Resume`, `--resume <id>` | `AcceptedSessionRef` | Post-spawn | Same create announcement |
| Fresh Amplifier | Freshell UUID + provider stub | `Resume`, existing stub/cwd rules | `ServerPreallocated` | Post-spawn | Same create announcement |
| Explicit Amplifier `sessionRef` | Accepted matching ref | Existing resume/stub rules | `AcceptedSessionRef` | Post-spawn | Same create announcement |
| Fresh OpenCode | None at launch | No `--session`; arm existing locator | None until locator | Pending marker after spawn; binding after discovery | Association, changed, metadata |
| Explicit OpenCode `sessionRef` | Accepted matching ref | `--session <id>` | `AcceptedSessionRef` | Post-spawn | Create announcement |
| Fresh Codex | None at launch | Existing plain/managed fresh launch + rollout locator | None until locator | Pending marker after spawn; binding after discovery | Association, changed, metadata |
| Explicit Codex `sessionRef` | Accepted matching ref | Existing plain/managed resume | `AcceptedSessionRef` | Post-spawn | Create announcement |
| Legacy raw resume, indexed `Present` | Raw field | Existing provider resume argv | `ExistenceValidatedLegacyResume` | Post-spawn | Create announcement |
| Legacy raw resume, `Unknown`/`ProviderUnavailable` | Raw field | Compatibility launch; row keeps the launch hint | Not yet authoritative; **deferred re-authorization** re-runs on index warm and publishes via the discovered pipeline on `Present` | None until re-authorized | `terminals.changed` at create; `associated -> changed -> meta` on late authorization |
| Legacy raw resume, `Absent` (warm index) | Raw field | Compatibility launch; row keeps the launch hint | Permanently non-authoritative; structured warning | None | `terminals.changed` only |
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
pub enum BoundOwner { Terminal { terminal_id: String }, FreshAgent { live_session_key: String } }

pub enum AdmissionClaim {
    Acquired,
    Held { retry_after_ms: u64 },
    BoundLive { owner: BoundOwner },      // adopt if same kind; refuse if cross-kind
    ExpiredNeedsKill { handle: KillHandle },
}

pub struct SessionAdmission {
    // ONE std Mutex over both maps — the same lock discipline both existing
    // maps already use.
    inner: Mutex<Inner>, // { leases: HashMap<Key, Lease>, bindings: HashMap<Key, BoundOwner> }
}
```

API: `claim(provider, sid, holder_id, kind, now_ms)`, `set_kill_handle`,
`complete(…, BoundOwner)` (binding insert + lease removal in one lock scope,
preserving the existing TOCTOU closures at `registry.rs:2103-2116` and
`session_lease.rs:218-221`), `fail`,
`clear_binding_if_owner(provider, sid, expected_owner)` (epoch-conditional),
`release_for_conn(conn)` (Terminal holders only),
`force_release_after_confirmed_kill`, and
`claim_discovered(provider, sid, owner)` for identity-discovered adoption.

**Replace the storage, keep the facades.**
`TerminalRegistry::claim_session_ref` keeps its signature and its step-1a
row-join + known-dead pruning (registry locks are taken and released before
the admission lock — the acyclic order documented at `registry.rs:1947-1951`),
but its lease/binding maps delegate to an injected `Arc<SessionAdmission>`.
`FreshAgentSessionLeases` becomes a thin facade over the same `Arc` (its
kill-tree machinery in `session_lease.rs:65-188` stays; only map storage
moves). `main.rs` constructs **one** `SessionAdmission` and injects it into
the registry and all fresh-agent states — the same wiring precedent as the
shared `SpawnGate` and `FreshAgentSessionLeases` (`main.rs:236-261`). Facade
preservation must keep the existing 900-line lease suite and the D8 registry
tests green without semantic edits.

**Cross-kind answers (D2/D3):**

- Same-kind `BoundLive` → existing adopt/attach behavior, unchanged.
- Cross-kind `BoundLive` → deterministic refusal, never adoption: terminal
  doors answer `RESTORE_UNAVAILABLE` (409 on REST, the error frame on WS);
  fresh-agent doors answer `SESSION_RESERVED { retryable: true }`. A new
  `SessionRefClaim::OwnedByFreshAgent` variant carries this through the
  registry facade.
- Cross-kind `ExpiredNeedsKill` → v1 answers `Held`/409; the holder's own
  kind performs its kill. No cross-kind sweeping.
- `claim_discovered` cross-kind conflict → refuse the binding atomically,
  leave the process running, `tracing::error!(target: "invariant")`, and a
  user-visible client notification via the same loud surface as the existing
  D8 duplicate-session alarm (`alarm_if_duplicate_session_ref`). Never kill
  (D3).

**Spawn-door inventory routed through the claim:** WS `terminal.create`
(negotiated; legacy session-carrying creates are removed per D5), REST
`POST /api/tabs` / split / respawn (including the legacy-raw rung, which
today claims nothing), fresh-agent create and attach for claude/codex/
opencode, auto-resume respawn, OpenCode signal-rebind restart, and recovery
flows. Release paths: terminal spawn failure → existing RAII
`fail_session_ref_claim` guards → facade `fail`; PTY exit/kill →
`clear_binding_if_owner(Terminal{terminal_id})` (known-dead pruning stays as
backstop); conn death → `release_for_conn`; fresh-agent sidecar failure →
`fail`; session exit watcher → owner-conditional `clear_binding_if_owner`;
TTL tree-kill → `force_release_after_confirmed_kill`. Server restart: table
is in-memory, like both current maps.

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
   `live_session_owner` join. A live owner rejects with
   `LiveFreshAgentOwner` (409/`RESTORE_UNAVAILABLE` at the door) even when
   existence would be `Unknown`/`Absent`. (Defense-in-depth: the atomic
   defense is the door's `SessionAdmission` claim; authorization ordering
   makes the sink safe for discovered candidates and keeps liveness
   independent of a warm disk index.)
3. Only for `LegacyResume`, map existence:
   `Present → ExistenceValidatedLegacyResume`,
   `Absent → LegacyIdentityAbsent` (permanent),
   `Unknown → LegacyIdentityUnconfirmed` (deferrable),
   `ProviderUnavailable → ProviderUnavailable` (deferrable).
4. All other authoritative sources convert directly to matching provenance.

**Deferred re-authorization (Slice F5):** a launched-but-unconfirmed legacy
candidate (`Unknown`/`ProviderUnavailable`) is recorded as an unconfirmed
marker `{candidate, terminal_id, create_request_id}` owned by the sink. The
existing probe contract already converges on re-query
(`existence.rs` module doc; test
`session_written_after_cold_read_resolves_present_on_requery`). A bounded
requery worker re-runs authorization after index warm/refresh; on `Present`
it publishes through the discovered pipeline
(`publish_running_session_identity` + sink persist/announce) with provenance
`ExistenceValidatedLegacyResume`. Warm `Absent` drops the marker permanently
with a structured warning. Markers are dropped on terminal exit.
`Absent` at create time is never deferred.

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

## Callback Contract and Lock Order (LB3)

Confirmed safe only under this permanent contract — document it on the trait
and test the final adapter:

- `upsert_with_retirement` remains a leaf write-lock operation on the
  identity registry.
- The synchronous publication callback does no broadcast, no ledger I/O, no
  runtime probing, no await, and no terminal-registry re-entry.
- No identity-registry method calls terminal-registry code while retaining an
  identity guard.
- Registry inner/terminal locks are taken strictly before the admission lock,
  never nested inversely (`registry.rs:1947-1951` discipline survives the
  extraction).

## Lifecycle Corrections (G1)

- **No pre-spawn ledger writes (LB5 decision).** The previous revision's
  guarded pre-spawn `record_binding` wrote an ordinary `Bound` row that
  recovery inventory exposes as `ledgerOnly`
  (`recovery_inventory.rs:254-265`), opening a competing-recovery window.
  G1 offered a durable prepared state *if pre-spawn durability is required*.
  It is not: the only asset protected is the pane↔session binding for a
  crash inside the create window, and the provider-side session (which the
  minted-id process itself creates) is independently recoverable through the
  history index. This plan therefore performs **all** ledger writes
  post-spawn, deleting the prepared-state machinery, the pre/post settlement
  aggregation, and the pre-spawn failure-cleanup delete. Spawn failure writes
  nothing and releases the admission lease via RAII.
- **Caller-held finalization guard (LB6).** `create_with_publication` returns
  a `CreateFinalizationGuard`. The wrapped exit hook waits on it; the caller
  holds it through provider settlement, the awaited durable write, and the
  announcement enqueue, then drops it. Drop (any path, including unwind)
  opens the gate. Exit cleanup can therefore never resurrect a row after
  retirement, delete a pending marker before it is written, or announce a
  retired terminal as created.
- **Gate opens on every error path (LB4).** The guard is created immediately
  after successful PTY creation, before registry insertion. Duplicate
  terminal ids are rejected without replacing or dropping a `PtyTerminal`
  while `RegistryInner` is held (the current insert ignores a replaced map
  value — fix that). Barrier tests cover the duplicate-error path and a
  `catch_unwind` publisher panic, proving the gate opens before every
  possible PTY join.
- **Exit-cause model (LB7).**

  ```rust
  #[derive(Debug, Clone, Copy, PartialEq, Eq)]
  pub enum TerminalExitCause { NaturalExit, ExplicitClose }
  ```

  `retire_terminal_identity(terminal_id, cause)`: both causes mark the
  in-memory identity retired (retained). Only `ExplicitClose` runs
  `retire_closed_if_owned` on the ledger. Natural exit, successful and
  exhausted auto-resume, and graceful shutdown leave rows `Bound`
  (`auto_resume.rs` doc: a still-Bound row is the not-closed signal;
  `retire_closed`'s single production call site today is `handle_kill`,
  `ws/terminal.rs:3880/3895` — that discipline is preserved and extended to
  the REST close door). Graceful shutdown calls no new retirement.
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
  `crates/freshell-ws/src/identity_sink.rs`. Verified feasible with no cycle:
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
  loudly (`.expect("identity sink wired twice")` on the boot path); the
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
  -> claim_discovered (atomic; cross-kind conflict -> loud refusal, D3)
  -> authorize (live-owner first)
  -> registry running-row identity transition + identity upsert
     (one registry critical section)
  -> awaited durable binding, then epoch-guarded pending delete
  -> terminal.session.associated -> terminals.changed -> terminal.meta.updated

exit:
  finalization guard wait (create settlement completes first)
  -> finish_pty_exit
  -> retire_terminal_identity(terminal_id, cause):
       memory identity marked retired (retained)
       ExplicitClose only: retire_closed_if_owned + epoch-guarded pending delete
       NaturalExit: no ledger retirement (rows stay Bound; auto-resume intact)
  -> admission clear_binding_if_owner
  -> provider-specific locator/sidecar/stub cleanup
```

All "before the HTTP response" claims are enqueue claims (see Global
Constraints). Handshake-inventory resync is the recovery invariant for missed
frames.

## File Map

- Create `crates/freshell-terminal/src/session_admission.rs`: shared
  cross-kind admission table.
- Modify `crates/freshell-terminal/src/registry.rs`: D8 facade over
  `SessionAdmission`; `create_with_publication` + finalization guard; atomic
  running/retired identity transitions; duplicate-id rejection fix.
- Modify `crates/freshell-terminal/src/lib.rs`: export the admission module.
- Modify `crates/freshell-freshagent/src/session_lease.rs`:
  `FreshAgentSessionLeases` becomes a facade over the shared table.
- Modify `crates/freshell-freshagent/src/identity_sink.rs`: provenance types,
  pure classifier (four providers only), trait extension, extended
  `FakeIdentitySink`.
- Modify `crates/freshell-freshagent/src/lib.rs`: re-exports; loud sink
  wiring; `identity_sink_wired()`.
- Modify `crates/freshell-freshagent/src/terminal_tabs.rs`: provenance-aware
  derivation, fresh Claude mint, admission claim on the legacy rung,
  probe-before-stub ordering, known-identity create publication, pending
  publication, cause-aware retirement, ordered REST announcement, scoped pane
  promotion.
- Modify `crates/freshell-freshagent/src/{claude,codex,opencode_ws}.rs`: loud
  sink setters/getters for boot assertions; lease facade call sites
  unchanged.
- Create `crates/freshell-ws/src/identity_sink.rs`: the production
  `LedgerIdentitySink` (moved per LB18) with authorization ordering,
  exit-cause retirement, deferred-marker storage, announcement/revision
  ownership.
- Create `crates/freshell-ws/src/terminal_identity_publication.rs`:
  `publish_discovered_terminal_identity` / `publish_retired_signal_identity`
  helpers and the deferred re-authorization worker.
- Modify `crates/freshell-ws/src/lib.rs`: `WsState` carries the sink;
  `identity_sink_wired()`.
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
  construction glue; keep the bin unit-test harness (gf_ui incident, boot
  wiring/teardown tests).
- Modify `crates/freshell-server/src/main.rs`: one `SessionAdmission`, one
  sink, five-consumer injection, wired + `Arc::ptr_eq` boot assertions, weak
  owner probes.
- Modify `crates/freshell-server/src/terminals.rs`: authority-only projection
  for the four providers; gemini/kimi synthesis retained.
- Modify `crates/freshell-server/src/existence.rs`: probe-only /
  legacy-adjudication variant that ignores zero-turn broker-shaped stubs
  (trait touch in `crates/freshell-ws/src/existence.rs` if required).
- Modify `crates/freshell-platform/src/cli_launch.rs` + `lib.rs`: shared
  fresh-Claude preallocation predicate.
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
- Modify `test/integration/real/coding-cli-session-contract.test.ts`:
  version-gated OpenCode contract.
- Do not modify `src/store/selectors/sidebarSelectors.ts`.

## Harvesting the Claude-Focused Branch

Branch `fix/rest-terminal-session-identity` (worktree
`/home/dan/code/freshell/.worktrees/rest-terminal-session-identity`, head
`4d46c86a`) contains reviewed work. Do not merge wholesale; compare per
commit and reuse where invariants still hold:

- `180a15e9` "shared fresh-claude preallocation predicate for both create
  doors" maps directly onto **Slice E1** — compare/cherry-pick rather than
  rewrite.
- `4d46c86a` "REST claude creates mint a preallocated --session-id" overlaps
  **Slice E2**'s fresh-Claude arm; reuse its tests where they match this
  plan's publication pipeline.
- Its plan-fix commits (`4709ee8a` retire-on-natural-exit correction) agree
  with this plan's LB7 stance; treat them as corroboration.

Never edit that worktree; it may be owned by another agent.

---

# Implementation Slices

Design rules for every slice: (a) every RED is a runtime assertion failure —
the slice lands a compiling minimal stub together with its tests; (b) no
commit contains a red test; (c) no slice leaves any Cargo target uncompilable
at its commit boundary; (d) trait growth never breaks a downstream implementer
across a slice boundary (defaults flipped to required within one slice);
(e) every focused command names a real crate/target and is not blocked by an
earlier slice.

- [ ] **Preflight (before Slice A):** confirm branch/base
  (`git log --oneline -3` shows this plan's commits atop `537d7d09`), then run
  the repo-supported baseline on this base via the shared test coordinator
  per `AGENTS.md`. Record counts in the implementation report. Stop on a red
  base.

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
    LegacyIdentityAbsent,        // permanent (warm-index miss)
    LegacyIdentityUnconfirmed,   // deferrable (cold index)
    ProviderUnavailable,         // deferrable (cold index, missing root)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalIdentityAuthorization {
    Publish(AuthorizedTerminalIdentity),
    Reject(TerminalIdentityRejection),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalDurabilityPhase { Postspawn, Discovery, Pending, Cleanup }

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
`crates/freshell-freshagent/src/terminal_tabs.rs`,
`crates/freshell-ws/src/terminal.rs`, `crates/freshell-server/src/main.rs`;
create `crates/freshell-ws/tests/cross_kind_admission.rs`.

- [ ] **Step 1 (B0.1 RED):** land `SessionAdmission` with `claim` stubbed to
  always return `Acquired` and `complete`/`clear_binding_if_owner` as
  recording no-ops, together with threadless unit pins in
  `session_admission::tests` (the `registry.rs:4655`-style staged-
  interleaving trick, no sleeps):

  - `claim_vs_claim_yields_exactly_one_acquired`
  - `claim_across_complete_answers_bound_live`
  - `cross_kind_bound_live_is_never_adoptable`
  - `claim_discovered_vs_lease_is_atomic`
  - `clear_binding_requires_owner_match`
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
  injected `Arc<SessionAdmission>` (public APIs and signatures preserved);
  add `SessionRefClaim::OwnedByFreshAgent`; map it to 409/`SESSION_RESERVED`
  per D2 at each door; extend the REST door's claim to the legacy rung; wire
  the single instance in `main.rs`. Facade preservation gates:

```bash
cargo test -p freshell-freshagent session_lease -- --nocapture
cargo test -p freshell-terminal session_ref -- --nocapture
cargo test -p freshell-ws --test freshagent_session_lease
cargo test -p freshell-ws --test cross_kind_liveness
cargo test -p freshell-freshagent terminal_tabs::tests::rest_terminal_resume_of_live_fresh_agent_session_returns_409 -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests::rest_legacy_raw_resume_claims_admission_before_spawn -- --exact --nocapture
cargo check -p freshell-server
git add crates/freshell-terminal/src/session_admission.rs \
  crates/freshell-terminal/src/registry.rs \
  crates/freshell-freshagent/src/session_lease.rs \
  crates/freshell-freshagent/src/terminal_tabs.rs \
  crates/freshell-ws/src/terminal.rs \
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
  2. the loser's exact structured error for its door (D2);
  3. exactly one writer post-hoc (≤1 sidecar create for S, ≤1 Running row,
     one writer pid in the fake provider transcript);
  4. loser-retry convergence after winner exit + binding clear.

  These are the LB14 acceptance gate. They should pass on first run if
  Steps 2–5 are correct; if any fails, that is a real admission bug — fix
  the table, not the test.

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

- `create_with_publication` order: create the finalization gate; wrap
  `on_exit` so the PTY reader waits on it; spawn the PTY; **create the
  open-on-drop guard immediately after successful PTY creation** (LB4); lock
  `RegistryInner`; run duplicate-resume checks; **reject a duplicate
  terminal id without replacing or dropping a `PtyTerminal` under the lock**
  (LB4 — fix the ignored-replacement insert at `registry.rs:979-986`); insert
  the row; invoke `publish` synchronously while the row is hidden behind the
  lock (leaf Callback Contract); bump the revision; drop the lock; preserve
  reservation release, structured log, and `ActivityEvent::Created` order;
  return the guard to the caller. `create` delegates with `|_| {}` and drops
  the guard immediately (legacy behavior preserved).
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
  `create` then invoke the publisher outside the lock; guard opens
  immediately; publish methods return `Missing`) together with all twelve
  tests, using barriers/channels, never sleeps:

  - `create_publication_hides_row_until_identity_callback_completes`
  - `immediate_exit_waits_for_finalization_guard`
  - `exit_hook_cannot_run_before_caller_settlement_completes` (LB6: caller
    holds the guard across a barrier standing in for durable-write +
    announcement; exit hook order-asserted after)
  - `finalization_guard_opens_on_publisher_panic` (LB4, `catch_unwind`)
  - `duplicate_terminal_id_rejects_without_dropping_running_pty` (LB4)
  - `discovered_identity_updates_running_row_and_callback_atomically`
  - `discovered_identity_cannot_publish_after_exit` (calls
    `finish_pty_exit` first; requires `NotRunning` + zero callbacks)
  - `expected_previous_identity_allows_atomic_rebind`
  - `stale_previous_identity_cannot_overwrite_current_binding`
  - `retired_rebind_updates_identity_without_changing_exit_status`
  - `retired_rebind_requires_expected_previous_identity`
  - `create_wrapper_preserves_legacy_behavior`

  RED: atomicity/ordering/result assertions fail at runtime against the
  naive stubs.

- [ ] **Step 2 (GREEN + refactor):** implement the gate/lock ordering and
  transitions; run **all twelve** focused (no drift — every declared test is
  run):

```bash
cargo test -p freshell-terminal registry::tests::create_publication_hides_row_until_identity_callback_completes -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::immediate_exit_waits_for_finalization_guard -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::exit_hook_cannot_run_before_caller_settlement_completes -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::finalization_guard_opens_on_publisher_panic -- --exact --nocapture
cargo test -p freshell-terminal registry::tests::duplicate_terminal_id_rejects_without_dropping_running_pty -- --exact --nocapture
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
legacy-adjudication probe variant.

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

fn retire_terminal_identity(&self, terminal_id: &str, cause: TerminalExitCause);

fn defer_legacy_reauthorization(&self, candidate: TerminalIdentityCandidate);
fn drop_legacy_reauthorization(&self, terminal_id: &str);

fn announce_terminal_identity(&self, announcement: TerminalIdentityAnnouncement);
```

(`TerminalAuthorization`/`TerminalDurabilityWrite` are the existing
boxed-future aliases. There is **no** `delete_terminal_binding_if_owned`
trait method: with pre-spawn writes removed, its only consumer is gone;
epoch-guarded cleanup goes through `retire_terminal_identity`'s
`ExplicitClose` lane and the C1 primitives.)

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
  (live-owner checks for **all** candidates before existence mapping); the
  amplifier arm of the owner probe answers `false` (no runtime today; adding
  one is a table entry).
- `publish_terminal_identity_memory` maps visibility to
  `upsert_with_retirement` only (leaf; Callback Contract documented on the
  method).
- Durability methods: typed `LedgerUnavailable` when `!ledger.is_enabled()`;
  event time captured before `spawn_blocking`; success → `Durable`; I/O
  error vs `JoinError` → distinct typed variants. `Discovery` writes the
  binding first, then the epoch-guarded pending delete; a pending-delete
  failure logs but never downgrades a durable binding.
- `retire_terminal_identity(terminal_id, cause)` is synchronous-callable from
  the PTY reader hook: it marks the in-memory identity retired immediately
  (retained), drops any deferred re-auth marker, then spawns one ordered
  async cleanup job via the runtime handle; only `ExplicitClose` runs
  `retire_closed_if_owned` + `delete_pending_if_owned` on `spawn_blocking`.
  Test-only completion receiver for deterministic waits.
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
  - `amplifier_uses_the_provider_aware_no_runtime_arm`
  - `legacy_adjudication_ignores_zero_turn_broker_stubs` (LB15 probe arm,
    fake existence source)
  - `natural_exit_retires_memory_but_leaves_ledger_bound` (LB7)
  - `explicit_close_retires_ledger_via_epoch_guard` (LB7/LB8)
  - `retirement_retires_memory_then_runs_ledger_cleanup_off_reader_thread`

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
cargo check -p freshell-server
cargo fmt --all --check
cargo clippy -p freshell-freshagent -p freshell-ws -p freshell-server --all-targets -- -D warnings
```

- [ ] **Step 3 (Commit):**

```bash
git add crates/freshell-freshagent/src/identity_sink.rs \
  crates/freshell-freshagent/src/lib.rs \
  crates/freshell-freshagent/src/claude.rs \
  crates/freshell-freshagent/src/codex.rs \
  crates/freshell-freshagent/src/opencode_ws.rs \
  crates/freshell-ws/src/identity_sink.rs \
  crates/freshell-ws/src/lib.rs \
  crates/freshell-ws/src/existence.rs \
  crates/freshell-server/src/identity_sink.rs \
  crates/freshell-server/src/existence.rs \
  crates/freshell-server/src/main.rs
git commit -m "feat(ws): shared terminal identity sink with typed durability and boot wiring"
```

---

### Slice E1 — Fresh-Claude preallocation predicate

**Files:** `crates/freshell-platform/src/cli_launch.rs`,
`crates/freshell-platform/src/lib.rs`.

Compare with Claude-branch commit `180a15e9` first; cherry-pick/adapt if its
predicate and truth table match this signature.

```rust
pub fn should_preallocate_fresh_claude(
    mode: &str,
    restore: Option<bool>,
    has_parsed_session_ref: bool,
    resume_session_id: Option<&str>,
) -> bool
```

- [ ] **Step 1 (RED):** land the predicate stubbed `false` + the truth table
  test `fresh_claude_preallocation_truth_table` (the two `assert!(p(...))`
  rows fail at runtime):

```rust
assert!(p("claude", None, false, None));
assert!(p("claude", Some(false), false, Some("")));
assert!(!p("claude", Some(true), false, None));
assert!(!p("claude", None, true, None));
assert!(!p("claude", None, false, Some(CLAUDE_ID)));
assert!(!p("codex", None, false, None));
assert!(!p("opencode", None, false, None));
assert!(!p("amplifier", None, false, None));
```

- [ ] **Step 2 (GREEN + commit):**

```bash
cargo test -p freshell-platform fresh_claude_preallocation_truth_table -- --exact --nocapture
cargo test -p freshell-platform --all-targets
cargo fmt --all --check
cargo clippy -p freshell-platform --all-targets -- -D warnings
git add crates/freshell-platform/src/cli_launch.rs crates/freshell-platform/src/lib.rs
git commit -m "feat(platform): fresh-claude preallocation predicate"
```

---

### Slice E2 — REST known-identity publication + the exact `gf ui` incident

**Files:** `crates/freshell-freshagent/src/terminal_tabs.rs`,
`crates/freshell-server/src/identity_sink.rs` (gf_ui test harness),
`crates/freshell-server/src/main.rs` (wiring only if needed).

**Interfaces:**

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
settle inputs/spawn result as needed.

- [ ] **Step 1 (RED, all runtime, all in-slice):**

  In `crates/freshell-server/src/identity_sink.rs` tests, the exact incident
  reproduction `gf_ui_rest_recovery_publishes_directory_memory_and_durable_identity`:
  merged in-process router over one real `TerminalRegistry`,
  `TerminalIdentityRegistry`, enabled temp-root `PaneLedger`, directory
  state, broadcast bus, and a recording Codex executable. Seed the old
  binding:

```rust
ledger.record_binding(&BindingWrite {
    provider: "codex",
    session_id: "019f9cb3-f11e-79f3-a968-287a5bc5798c",
    terminal_id: "981008-old-gf-ui",
    mode: "codex",
    cwd: Some("/home/dan/code/glowforge"),
    create_request_id: Some("old-gf-ui"),
    now_ms: 1,
})?;
```

  POST `{"name":"gf ui","mode":"codex","cwd":"<temp>/glowforge",
  "createRequestId":"gf-ui-rest-recovery","sessionRef":{"provider":"codex",
  "sessionId":"019f9cb3-f11e-79f3-a968-287a5bc5798c"}}` and assert the
  three-way tuple (directory ref, identity `session_ref_for`, live ledger
  terminal) all name the new terminal and the incident session, plus exactly
  one resume invocation in the recording executable.

  Run and record the genuine RED tuple:

```bash
cargo test -p freshell-server identity_sink::tests::gf_ui_rest_recovery_publishes_directory_memory_and_durable_identity -- --exact --nocapture
```

  Expected current tuple: `(None, None, Some("981008-old-gf-ui"))`. Save the
  exact output for the implementation report.

  In `terminal_tabs::tests`, the route matrix (against the Slice D sink API,
  which exists — genuine runtime REDs):

  - `fresh_claude_rest_create_uses_start_and_publishes_minted_identity`
  - `explicit_claude_codex_opencode_and_amplifier_refs_publish_identity`
    (four recording CLI specs; directory/identity/reloaded-ledger all equal
    the request ref per provider)
  - `fresh_amplifier_preserves_stub_before_spawn_and_publishes_minted_identity`
    (recording executable checks `events.jsonl` existed at process start and
    argv carries the minted UUID in resume position)
  - `amplifier_legacy_raw_id_is_probed_before_any_stub_write` (LB15: a
    never-existing raw id must NOT be re-stubbed; existence adjudication
    happens first; rescope/replace the old
    `requested_amplifier_resume_with_missing_dir_is_restubbed_under_same_id`
    expectation for the legacy arm — accepted/minted arms unchanged)
  - `raw_resume_publishes_only_after_present_existence`
  - `raw_resume_unknown_existence_launches_and_records_deferred_marker`
    (LB12 arm: launch OK, no published identity, marker recorded via fake
    sink; no pane `sessionRef` promotion)
  - `pane_content_session_ref_is_stamped_only_for_authorized_identities`
    (four providers; gemini/kimi promotion untouched — carve-out pin)
  - `spawn_failure_writes_no_binding_and_frees_admission` (post-spawn-only
    durability: nothing durable exists to clean; admission lease released)
  - `immediate_exit_retires_after_atomic_publication`
  - `natural_exit_leaves_ledger_bound_explicit_close_retires` (route-level
    LB7: exit hook passes `NaturalExit`; REST close path passes
    `ExplicitClose`)
  - `tab_split_and_respawn_share_the_known_identity_pipeline`

- [ ] **Step 2 (GREEN):** implement in `terminal_tabs.rs`:

  1. `DerivedResumeIdentity` (use `parsed_session_ref_present`, not raw JSON
     field presence; `"sessionRef": null` is absent and still mints; a
     parsed ref for any provider disables minting).
  2. Fresh-Claude policy via `should_preallocate_fresh_claude`:
     minted UUID, `ServerPreallocated`, `LaunchIntent::Start`.
  3. Amplifier: preserve mint/stub/cwd logic; `ServerPreallocated` only when
     this request minted the UUID; **legacy raw ids run probe-only existence
     authorization before `ensure_session`** (LB15); stub still precedes
     `registry.create`.
  4. Candidate construction + `authorize_terminal_identity` before spawn
     (admission claim already precedes it from Slice B0). On
     `LiveFreshAgentOwner` → existing planned-launch/stub cleanup +
     `409 RESTORE_UNAVAILABLE`. On deferrable legacy rejection → launch,
     `authorized_identity = None`, `defer_legacy_reauthorization`, structured
     log. On permanent `LegacyIdentityAbsent` → launch, structured warning
     only. Managed-Codex planner id mismatch → 500 before spawn.
  5. `create_with_publication` with the synchronous memory-publish callback
     (`debug_assert_eq!` terminal ids); hold the returned
     `CreateFinalizationGuard` through settlement; exit hook calls
     `retire_terminal_identity(id, NaturalExit)` after `finish_pty_exit`;
     the REST explicit-close door calls the `ExplicitClose` retire.
  6. Post-spawn awaited `persist_terminal_identity(…, Postspawn)` for every
     authorized identity (no pre-spawn writes, no settlement aggregation —
     single result). `persist_terminal_pending` for identityless fresh
     Codex/OpenCode creates, epoch-keyed.
  7. Scoped pane promotion per LB10 consumer table.

```bash
cargo test -p freshell-platform fresh_claude_preallocation_truth_table -- --exact --nocapture
cargo test -p freshell-freshagent terminal_tabs::tests -- --nocapture
cargo test -p freshell-server identity_sink::tests::gf_ui_rest_recovery_publishes_directory_memory_and_durable_identity -- --exact --nocapture
cargo test -p freshell-freshagent --all-targets
cargo fmt --all --check
cargo clippy -p freshell-freshagent -p freshell-server --all-targets -- -D warnings
```

  The `gf ui` tuple must now name the new terminal in all three positions;
  record the GREEN tuple next to the RED one.

- [ ] **Step 3 (Commit — the incident test lands green in the same commit
  that fixes it):**

```bash
git add crates/freshell-freshagent/src/terminal_tabs.rs \
  crates/freshell-server/src/identity_sink.rs \
  crates/freshell-server/src/main.rs
git commit -m "fix(rest): publish authoritative terminal identities"
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

Discovered algorithm: `claim_discovered` on the admission table (cross-kind
conflict → atomic refusal + D3 loud surface, process left running) →
`authorize_terminal_identity` (live-owner first) →
`registry.publish_running_session_identity` with the expected previous id →
synchronous `publish_terminal_identity_memory(Live)` in its callback → on
`Published`, awaited `persist_terminal_identity(…, Discovery)` (binding
first, then epoch-guarded pending delete) → announce `Associated` with
`previous_session_id`. On `AlreadyPublished`/`Missing`/`NotRunning`/
`ModeMismatch`/`ConflictingIdentity`: no persist, no announce. This closes
the read-running-then-late-upsert early-exit race.

Retired algorithm (LB9): reuses authorization/durability/announcement but
publishes memory with `Retired` and calls
`registry.publish_retired_session_identity`. When the registry row is
**absent** (explicit kill removed it), a `Missing` result is **permitted**
if and only if the retained retired identity entry matches the exact
`previous_session_id` CAS; then update identity registry (retired) + ledger
only — no fabricated row, no `registry.set_meta`, no `terminal.created`, no
live activity event. Emits `associated -> changed -> retired meta`.

- [ ] **F0:** add a ws-local `RecordingSink` test double (or promote
  freshagent's `FakeIdentitySink` behind a `test-util` feature — pick one;
  the freshagent fake is `#[cfg(test)] pub(crate)` and invisible to
  `freshell-ws`). Commit
  `test(ws): recording identity sink test double`.
- [ ] **F1 (OpenCode locator):** RED — land the helper stubbed to
  authorize-and-return-`Missing` plus tests
  - `fresh_opencode_launch_has_no_session_arg_and_records_pending`
    (argv has no `--session`; epoch-keyed pending marker exists)
  - `opencode_locator_discovery_uses_shared_memory_durability_and_announcement`
    (RecordingSink observes exactly
    `claim_discovered -> authorize(ProviderDiscovered) -> publish_memory ->
    persist(Discovery) -> announce(Associated)`)
  - `opencode_discovery_after_exit_publishes_nothing`
  - `opencode_discovery_rejects_live_fresh_agent_owner`

  GREEN — implement the helper; migrate the locator write tail (replace
  `identity.upsert` / `registry.set_meta` / `ledger_resolve_identity` /
  `broadcast_terminal_session_associated`) keeping `OpencodeLocator::arm`,
  `note_submit`, `tick`, root resolution, and single-bind rules unchanged.

```bash
cargo test -p freshell-ws opencode_association::tests -- --nocapture
cargo test -p freshell-ws --test opencode_switch_rebind
git add crates/freshell-ws/src/terminal_identity_publication.rs crates/freshell-ws/src/opencode_association.rs crates/freshell-ws/src/lib.rs
git commit -m "refactor(ws): opencode discovery publishes through the shared sink"
```

- [ ] **F2 (Codex discovery/fork):** RED — add a RecordingSink assertion to
  the existing green pins
  (`codex_association::tests::drain_and_associate_binds_identity_ledger_and_broadcasts`,
  `--test codex_fork_rebind`) — the new assertion fails at runtime while the
  old fan-out bypasses the sink. GREEN — migrate the write tail through the
  helper, route adoption through `claim_discovered` (replacing the
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
  `opencode_retired_signal_rebind_stays_retired_and_announces_layout_identity`
  and `retired_rebind_with_absent_registry_row_uses_retained_identity_cas`
  fail at runtime against the stub. GREEN — route OpenCode and Claude signal
  rebind tails through the shared publishers, preserving guard ladders,
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
  `NaturalExit`; `handle_kill` switches to
  `retire_terminal_identity(id, ExplicitClose)` backed by
  `retire_closed_if_owned`. Do not change request-id dedupe, attach/adopt
  branches, or provider launch arguments. Auto-resume pins must stay green
  (LB7 + drift constraint: no interference with `auto_resume_cancels` or
  settle frames).

```bash
cargo test -p freshell-ws ws_known_create_publishes_through_shared_sink -- --nocapture
cargo test -p freshell-ws --test session_identity_frames
cargo test -p freshell-ws --test live_session_ref_guard
cargo test -p freshell-ws --test pane_ledger_triggers
cargo test -p freshell-ws --test auto_resume_e2e -- --nocapture
git add crates/freshell-ws/src/terminal.rs
git commit -m "refactor(ws): share known-create terminal identity publication"
```

- [ ] **F5 (deferred re-authorization, LB12):** RED —
  `unknown_legacy_resume_authorizes_late_and_publishes_via_discovered_pipeline`
  (fake existence probe answers `Unknown`, terminal launches with a deferred
  marker, probe flips to `Present`, worker publishes; assert
  `associated -> changed -> meta` and the published
  `ExistenceValidatedLegacyResume` identity) and
  `absent_legacy_resume_is_permanently_rejected_without_requery` fail
  against the stub worker. GREEN — implement the bounded requery worker in
  `terminal_identity_publication.rs` over the sink's deferred markers,
  triggered by index warm/refresh completion; markers dropped on exit.

```bash
cargo test -p freshell-ws unknown_legacy_resume_authorizes_late_and_publishes_via_discovered_pipeline -- --nocapture
cargo test -p freshell-ws absent_legacy_resume_is_permanently_rejected_without_requery -- --nocapture
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

- [ ] **Step 2 (GREEN):** `create_terminal_tab` announces after durable
  settlement via `announce_terminal_identity`, then returns; deferred
  delivery returns the command in the body. Split/respawn callers use the
  same settlement announcement after their UI command; never announce inside
  the lower spawn helper before caller bookkeeping exists.
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
- [ ] **Step 5 (verify + commit):**

```bash
cargo test -p freshell-freshagent terminal_tabs::tests -- --nocapture
npm run test:vitest -- run test/unit/client/components/App.ws-bootstrap.test.tsx
npm run test:vitest -- run test/unit/client/lib/terminal-invalidation-handler.test.ts
npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.test.ts
cargo fmt --all --check
cargo clippy -p freshell-freshagent --all-targets -- -D warnings
git add crates/freshell-freshagent/src/terminal_tabs.rs test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "fix(client): invalidate REST terminal identity in order"
```

---

### Slice I — Merged integration, real-provider, and browser acceptance

Acceptance pins over already-green behavior — green-on-land is correct here;
no red phase required.

**Files:** create `crates/freshell-ws/tests/rest_terminal_identity.rs`;
modify `test/integration/real/coding-cli-session-contract.test.ts`; create
`test/e2e-browser/specs/rest-terminal-identity-rust.spec.ts`.

- [ ] **Step 1:** merged-server harness reusing the
  `rest_ws_shared_gate.rs` listener/router pattern and the real-ledger state
  pattern from `tests/common/mod.rs`, importing the **production**
  `freshell_ws::identity_sink::LedgerIdentitySink` (LB18 resolved by
  Slice D). Recording executables for all four providers; every root under
  one `TempDir`.
- [ ] **Step 2:** the exact incident test
  `gf_ui_rest_recovery_is_one_process_one_identity_one_sidebar_key`
  (`multi_thread` flavor): one process invocation, one tab/pane, new row +
  identity registry + live ledger + fresh-`PaneLedger` reload all naming the
  exact Codex ref, and ordered changed/meta frames **enqueued before the
  response completes** (test-subscriber observation).
- [ ] **Step 3:** provider matrix (`multi_thread`):
  - `explicit_refs_publish_for_all_four_terminal_providers`
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
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/coding-cli-session-contract.test.ts
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/amplifier-stub-adoption-contract.test.ts --config config/vitest/vitest.server.config.ts
```

- [ ] **Step 7 (browser E2E):** one Rust-only Playwright spec using the fake
  provider fixtures and scratch-server conventions from
  `pane-ledger-restart-rust.spec.ts`: exact `gf ui` Codex resume → one
  sidebar row + one process-log entry; fresh Claude (`--session-id <uuid>`);
  fresh Amplifier (stub before start receipt); fresh OpenCode (no
  `--session`, locator materialization, one canonical row); spec-owned
  scratch restart; restored panes resume with the durable ids. Never
  reference port 3002.

```bash
npm run test:e2e -- test/e2e-browser/specs/rest-terminal-identity-rust.spec.ts --project=rust-chromium
```

- [ ] **Step 8 (Commit):** after GREEN, extract shared harness helpers into
  `crates/freshell-ws/tests/common/mod.rs` only if at least two test files
  use identical code; rerun Steps 4/6/7.

```bash
git add crates/freshell-ws/tests/rest_terminal_identity.rs \
  test/integration/real/coding-cli-session-contract.test.ts \
  test/e2e-browser/specs/rest-terminal-identity-rust.spec.ts
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

  No protocol message additions are expected beyond the
  `SessionRefClaim::OwnedByFreshAgent` server-internal variant; the existing
  `durability.degraded`, `terminals.changed`, `terminal.session.associated`,
  `terminal.meta.updated`, and `ProtocolMismatch` surfaces are reused. If
  contract generation shows drift, stop and report before regenerating.

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

  - worktree, branch, base SHA (`537d7d09`), head SHA, and the fresh
    baseline evidence from Preflight
  - focused commits per slice
  - exact `gf ui` RED and GREEN tuples
  - cross-kind admission barrier-test evidence (exactly-one-winner for
    claude/codex/opencode on both doors, both orders) — this replaces the
    old "residual race" report item, which no longer exists
  - the D5 legacy-WS removal evidence (reject + plain-shell-allowed tests)
  - provider matrix outcomes; OpenCode no-preallocation evidence/version;
    pinned amplifier contract version and the key-gated skip status
  - deferred re-authorization evidence (Unknown→Present convergence)
  - ordinary-restart ledger reload evidence
  - enqueue-order assertions and the adverse-interleaving convergence test
  - focused and broad verification commands/outcomes; review rounds
  - readiness for explicit PR approval

## Acceptance Summary

1. The exact `gf ui` Codex recovery shape begins RED as
   `(None, None, "981008-old-gf-ui")` and ends with directory, memory
   registry, and disk-reloaded ledger all naming the new terminal and
   `019f9cb3-f11e-79f3-a968-287a5bc5798c`.
2. **Cross-kind admission is atomic:** one `SessionAdmission` table admits
   terminal and fresh-agent creates; barrier-synchronized tests prove
   exactly-one-winner and exactly-one-writer for claude, codex, and opencode
   on both doors (WS and REST), in both interleaving orders, with
   deterministic loser errors (REST 409 `RESTORE_UNAVAILABLE`, WS
   `RESTORE_UNAVAILABLE` frame, fresh-agent `SESSION_RESERVED` retryable).
   The previously deterministic REST-door two-writer hole has a direct
   regression test. No residual race is recorded or accepted.
3. A retroactively discovered identity that collides cross-kind is refused
   atomically with an invariant log and a user-visible error; the running
   process is never auto-killed.
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
   flows through claim_discovered + the shared memory/durability/retirement/
   invalidation pipeline; fresh Codex adoption and rebind tails use the same
   pipeline without changing discovery policy.
9. A legacy raw resume id becomes authoritative only on `Present` existence
   — immediately or through deferred re-authorization on index warm;
   `Absent` on a warm index is permanent; a live owner refuses the launch
   before existence is even consulted.
10. `/api/terminals` projects `sessionRef` only from the shared identity
    registry for claude/codex/opencode/amplifier, and retains the documented
    `mode + resume_session_id` synthesis for gemini/kimi (D1). Reconcile no
    longer echoes unpublished promoted claims for the four providers, so a
    legacy-unknown restore yields exactly one sidebar key.
11. A terminal registry row and its in-memory identity are never observably
    split; the exit hook cannot run before create settlement completes (the
    caller-held finalization guard opens on every success, error, and unwind
    path, proven by duplicate-id and publisher-panic tests); a
    discovery/exit race cannot resurrect stale identity.
12. Durable rows become `Closed` only on explicit user close; natural exit,
    auto-resume settlement, and graceful shutdown leave rows `Bound`
    (auto-resume e2e pins stay green); all delayed cleanup is
    epoch-conditional and cannot erase a replacement owner; the retired
    OpenCode missing-row rebind lane still works after explicit kill.
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
    gates pass on the fresh `537d7d09` baseline; all changes remain
    committed locally, undeployed, and without a PR.
