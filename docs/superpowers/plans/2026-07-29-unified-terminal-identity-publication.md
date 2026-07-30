# Unified Terminal Session Identity Publication — Invariants and Obligations Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan slice-by-slice. Steps use
> checkbox (`- [ ]`) syntax for tracking.

> **Revision 5 (strategy change, per user direction after Fresh Eyes round
> 4):** Round 4 found **no criticals** but eight blocking wiring/consistency
> defects inside the plan's own prescribed mechanics. The user directed a
> restructure: stop specifying implementation mechanics in the plan. Rounds
> 1–4 findings that constrain WHAT must be true are folded in below as
> binding invariants and per-slice obligations (round-4 findings are tagged
> `R4-F1`…`R4-F8`); everything that prescribed HOW (exact signatures, enum
> shapes, channel choreography, line-level edits) is deleted and left to
> in-slice design under per-slice review. The full prescriptive history is
> preserved in this file's git log and in
> `attempts/rest-terminal-identity-publication-20260729/HANDOFF.md`.

## How to read this plan

This plan specifies **WHAT must be true** — binding invariants, per-slice
obligations, scope boundaries, and test obligations — plus the slice order
and review gates. **HOW** each obligation is met (exact signatures, enum
shapes, channel choreography, line-level edits) is decided during
red/green/refactor implementation of each slice and validated by that
slice's spec review, code review, and tests. Four review rounds proved that
line-level prescription in a document this size generates inconsistencies
faster than review closes them; the invariants below are the review-stable
core that survived all four rounds plus five validation groups (G1–G5).

Concept names used below (`SessionAdmission`, `AdmissionEpoch`,
`BoundOwner`, `ConflictHold`, `HolderKind`, publication sink, finalization
guard, publication-time ownership record) are **vocabulary**, not API
specs. The implementer chooses the shapes; the reviewer checks them against
the invariants.

## Goal

Give every authoritative terminal session identity — accepted resume,
server-preallocated fresh identity, provider-discovered identity, or
existence-validated legacy resume — one provider-aware publication pipeline
that atomically joins the terminal row to the shared identity registry,
records the pane ledger durably, retires it correctly by exit cause, and
enqueues ordered client invalidations; and make cross-kind (terminal vs
fresh-agent) session admission a single atomic claim so that **two writers
are never admitted**. For providers that reveal identity only after launch,
a late-**discovered** collision is refused, poisoned, and loudly alarmed,
with exposure bounded by user action (D3-clarified; see "Admission
invariant, stated honestly" — this plan never claims absolute two-writer
prevention for that case).

## Incident and what PR #584 already fixed

A recovery agent used REST `POST /api/tabs` to resume the real Codex
session `019f9cb3-f11e-79f3-a968-287a5bc5798c` (`gf ui`,
`/home/dan/code/glowforge`). The spawn and D8 binding were correct, but the
REST path skipped `TerminalIdentityRegistry` and `PaneLedger`, so
`/api/terminals` showed the live terminal without a `sessionRef`, the pane
ledger still named the old terminal, and the sidebar rendered two keys —
the real `codex:019f9cb3-…` from the pane and a synthetic
`codex:terminal:8f673dee-…` from the unidentified directory row — for one
process. 132 evidence files are preserved under a SHA-256 manifest; never
touch them.

**That incident is FIXED on main.** PR #584 (kata `hbsa`) landed a
post-spawn identity-registration seam (`PaneIdentityBinder` /
`LedgerPaneIdentityBinder` in `crates/freshell-ws/src/pane_identity_binder.rs`),
REST fresh-Claude minting with `--session-id`, the shared preallocation
predicate `freshell_platform::should_preallocate_fresh_claude`, and e2e
pins (`crates/freshell-ws/tests/rest_claude_identity.rs`,
`rest_locator_identity.rs`). The incident shape becomes a permanent green
pin here (Slice I). What remains for this branch:

- The landed binder is **provenance-blind** — it publishes even unvalidated
  legacy raw ids. This plan absorbs it into the authorized sink and deletes
  it (Slice E2), leaving no parallel identity write path.
- #584's own plan records the **cross-kind admission race as out of scope**;
  the REST terminal door still performs no cross-kind check, so a REST
  terminal resume of a live fresh-agent-owned session spawns a second writer
  **deterministically** on current `origin/main` (G4). Slice B0 closes it.
- Everything else here: provenance/authorization model, lifecycle
  correctness, single settle/announcement mechanism, read-model alignment,
  boot wiring, and the acceptance suites.

Slice E1 (the preallocation predicate) landed verbatim in #584 and is
verify-only. Main's
`docs/superpowers/plans/2026-07-29-rest-terminal-session-identity.md` is
#584's historical plan — never edit it, never re-implement it.

## Approvals Already Granted (do not reopen)

The user made these product decisions after reviewing the validator packet.
Implementers and reviewers must encode them, not relitigate them.

- **D1 (LB16) — Gemini/Kimi unchanged.** Keep the existing
  `mode + resume_session_id` directory synthesis in `/api/terminals` and the
  existing pane promotion **solely** for `gemini`/`kimi`, as a documented
  compatibility carve-out. The four-provider existence model, the
  classifier, and the projection change are scoped to
  claude/codex/opencode/amplifier only. Kata `jb4z` tracks eventual
  deprecation of Gemini/Kimi session restore.
- **D2 (LB14) — Loser gets a structured refusal, not a redirect.** The
  cross-kind admission loser receives a deterministic structured error:
  REST `409 RESTORE_UNAVAILABLE`, WS `error{RESTORE_UNAVAILABLE}` frame,
  fresh-agent `create.failed{SESSION_RESERVED, retryable: true}`. No
  redirect-to-existing-pane feature in this branch.
- **D3 (LB14, clarified after round 3) — Retroactively discovered
  collision: ACCEPT + ALARM.** When a fresh Codex/OpenCode terminal
  discovers a session id another writer already owns (same kind or cross
  kind), refuse the binding atomically, install an epoch-carrying conflict
  hold (no third writer, no reopen), leave the running process alone, and
  raise a loud user-visible alarm plus an invariant-level log. By the time
  discovery fires, both processes are already attached to the session file
  — the guarantee for this case is honest refusal + containment + alarm,
  never undoing. Exposure is bounded by user action. Freezing or killing
  the newcomer is explicitly out of scope.
- **D4 (LB14) — The REST-door two-writer hole is fixed early in this
  branch.** The `SessionAdmission` extraction and REST-door protection are
  sequenced as Slice B0, before every publication slice. No separate hotfix
  PR.
- **D5 — Remove legacy (non-negotiated) WS session-carrying creates.** A
  `terminal.create` that carries session identity on a connection that did
  not negotiate `pane_reconcile_v1` is rejected with a deterministic
  structured error telling the client to refresh (F5); the legacy
  check-then-spawn path for session-carrying creates is removed, with a
  regression test. Plain-shell and identityless creates on legacy
  connections remain allowed and byte-for-byte unchanged. Rationale: we do
  not maintain server code for something an F5 fixes — this server serves
  the upgraded client.
- **Standing constraints (already in force):** no accepted **admission**
  race anywhere in this plan or its report — every create/attach/resume
  door claims atomically and the barrier suite proves exactly-one-winner;
  the sole documented exposure is the D3-clarified late-discovery window,
  stated honestly and never described as prevented; tests use fake provider
  homes and temp directories only; never touch port 3002 or the preserved
  evidence bundle; no PR until the user explicitly approves one.

## Out of Scope

- Any Gemini/Kimi identity-model change beyond preserving today's behavior
  (deprecation is kata `jb4z`).
- Redirect-the-loser-to-the-existing-pane UX (D2 chose refusal).
- Any policy that kills — or freezes/suspends — a running provider process
  on a discovered-identity collision (D3-clarified chose accept + alarm).
- An ack/barrier transport protocol for instantaneous client consistency
  (LB17: eventual convergence with handshake-inventory resync is accepted).
- PR creation, push, deploy, or any action against live port 3002.
- Node server behavior changes and client selector changes.
- New persistence schema for provenance (provenance lives at typed seams
  only — FE-R3-13).

## Admission invariant, stated honestly (D3-clarified)

> **Two writers are never ADMITTED.** No create, attach, or resume door can
> spawn or adopt a second writer for one provider session: every door
> claims the same atomic `SessionAdmission` key before spawning or binding,
> and the Slice B0 barrier suite is the gate.
>
> **A late-DISCOVERED collision is refused, poisoned, and loudly alarmed —
> not undone.** Codex and OpenCode reveal a fresh terminal's session id
> only after launch. If discovery reports an id another writer already
> owns, both processes are, at that instant, already attached to one
> session file. The table refuses the binding atomically, installs the
> conflict hold (no third writer, no reopen), and fires the alarm surface
> (I-28/I-29). This plan claims **admission** prevention everywhere and
> **absolute** two-writer prevention nowhere.

**Residual exposure (documented, bounded):** the window runs from the
refused process's provider-side attach at launch until the user closes one
of the two writers. During the window: no third writer can be admitted,
every further create/attach/resume for the key is refused, and the alarm
surfaces are live. The bound is **user action, prompted by the alarm**.
Doors that know identity before spawn (accepted refs, minted ids, legacy
raw resumes) can never produce this exposure.

## Provider and Provenance Matrix

Authoritative provenance values: **`AcceptedSessionRef`**,
**`ServerPreallocated`**, **`ProviderDiscovered`**,
**`ExistenceValidatedLegacyResume`**. A raw legacy `resumeSessionId` may
launch for compatibility, but it becomes authoritative only after the
shared existence probe returns `Present` — at create time or later through
deferred re-authorization. Never infer authoritative identity from
`mode + resumeSessionId`, CLI argv, a promoted pane payload, title, cwd,
output text, or an extension manifest (Gemini/Kimi's carve-out is
compatibility, not authority).

All session-carrying rows also acquire the `SessionAdmission` claim before
spawn (Slice B0); the matrix shows identity/publication behavior:

| Provider/create shape | Launch-time session source | Launch behavior | Provenance | Durability timing |
| --- | --- | --- | --- | --- |
| Fresh Claude | Freshell UUID (minting landed in #584) | `Start`, `--session-id <uuid>` | `ServerPreallocated` | Awaited PIN2 pre-spawn binding (the one LB5 exception) + post-spawn awaited write |
| Explicit Claude ref | Accepted matching ref | `Resume`, `--resume <id>` | `AcceptedSessionRef` | Post-spawn |
| Fresh Amplifier | Freshell UUID + provider stub | `Resume`, existing stub/cwd rules | `ServerPreallocated` | Post-spawn |
| Explicit Amplifier ref | Accepted matching ref | Existing resume/stub rules | `AcceptedSessionRef` | Post-spawn |
| Fresh OpenCode | None at launch | No `--session`; existing locator armed | None until locator | Pending marker after spawn; binding after discovery |
| Explicit OpenCode ref | Accepted matching ref | `--session <id>` | `AcceptedSessionRef` | Post-spawn |
| Fresh Codex | None at launch | Existing plain/managed launch + rollout locator | None until locator | Pending marker after spawn; binding after discovery |
| Explicit Codex ref | Accepted matching ref | Existing plain/managed resume | `AcceptedSessionRef` | Post-spawn |
| Legacy raw resume, indexed `Present` | Raw field | Existing provider resume argv | `ExistenceValidatedLegacyResume` | Post-spawn |
| Legacy raw resume, `Unknown` or stale-snapshot `Absent` | Raw field | Compatibility launch; row keeps the launch hint | Deferred re-authorization (I-9) | None until re-authorized |
| Legacy raw resume, fresh-index `Absent` or `ProviderUnavailable` | Raw field | Compatibility launch | Permanently non-authoritative; structured warning | None |
| Parsed ref with provider ≠ mode | — | **Rejected before spawn** (I-32) | — | — |
| Claude `restore:true`, no ref, no resume id | — | **Rejected before spawn** (I-32) | — | — |
| Gemini/Kimi (any restore shape) | Raw field | Entirely unchanged (D1) | Outside the model | Existing behavior |
| Shell/custom identityless | None | Existing launch | None | None |

Preserve the accepted `sessionRef` exactly: nonempty provider must equal
mode, and the published session id must be the accepted id. If managed
Codex planning returns a different id, fail before spawn rather than
silently changing authority. Never preallocate an OpenCode id (OpenCode
1.18.9 treats `--session <id>` as attach/resume and rejects a made-up id).

Deliberate LB15 behavior change: a legacy raw Amplifier id whose directory
was GC'd previously restored silently via automatic re-stub; under this
plan a legacy raw id is existence-authorized with a probe-only lookup
first, so that case fails loudly instead of fabricating provider state.
`ServerPreallocated`/`AcceptedSessionRef` re-stub behavior is unchanged;
the existing test is rescoped to previously-authorized ids.

## Launch hint vs authoritative identity (LB10)

The registry row's `resume_session_id` is a **launch fact** ("this PTY was
launched with `<cli> resume <id>`"), never by itself authoritative
identity. G3 enumerated sixteen production consumers; the split is
deliberate and reviewed:

- **Launch-fact consumers keep reading the raw row id, unchanged:**
  liveness/admission/dedupe/suppression must key on launch facts because a
  live process launched against id X is a real writer on X regardless of
  authorization. This covers: amplifier duplicate-resume reservation, the
  sessionRef↔row liveness joins and the D8 duplicate alarm,
  `live_session_owner`, stub-GC pre-checks, recovery-inventory suppression,
  the cross-kind liveness probes (now fast paths under `SessionAdmission`),
  activity-hub lane attachment, locator arm suppression, the OpenCode
  signal guard ladder, invariant checks, restore/ledger scans, D7 gating
  filters, and the `Created` activity payload.
- **Authority consumers read only published identity
  (`TerminalIdentityRegistry`):** the `/api/terminals` `sessionRef`
  projection for the four providers (Slice G), the pane-reconcile
  promoted-claim echo for the four providers (Slice G), WS handshake
  inventory stamping (already identity/ledger-based), and REST pane-content
  `sessionRef` promotion for the four providers (Slice E2). Gemini/kimi
  retain their existing behavior everywhere (D1).

Gating the liveness consumers on authorization would leave a real running
writer unprotected exactly when its id is unvalidated — recreating the
two-writer shape LB13/LB14 exist to kill. Do not "clean this up."

---

## Binding Invariants

Each invariant is a MUST. Every slice below names the invariants it proves;
per-slice spec review checks the in-slice design against them; per-slice
code review checks the code against them. Provenance tags refer to the
validation groups (G1–G5 / LB1–LB20) and Fresh Eyes rounds (FE-R1…R4).

### Admission

- **I-1 (one shared admission table).** One cross-kind `SessionAdmission`
  table — one lock over leases, bindings, and conflict holds, keyed by one
  canonical `(provider, session id)` function shared with the existing
  lease/session-ref keying — placed where both doors can reach it without a
  dependency cycle (`freshell-terminal`). Both existing lease stores
  (terminal D8 lease/binding maps in `registry.rs`;
  `FreshAgentSessionLeases` in `session_lease.rs`) become facades over the
  one injected instance, preserving their observable same-kind semantics
  (their existing suites stay green with only mechanical token-threading
  edits). The reciprocal liveness probes become UX fast paths only — never
  the defense. *(G4/LB14, D4)*
- **I-2 (claim before spawn/bind at every door).** Every door that can
  spawn or adopt a writer claims the table first: WS `terminal.create`
  (negotiated), REST create/split/respawn — **including the legacy-raw
  rung, which today claims nothing** — fresh-agent create **and attach**
  for claude/codex/opencode, auto-resume respawn, OpenCode signal-rebind
  restart, recovery flows, and discovery-time adoption. *(G4/LB14, LB13,
  R4-F6)*
- **I-3 (deterministic loser errors, per door and contention kind).**
  Cross-kind losers get the D2 errors (REST 409 `RESTORE_UNAVAILABLE`, WS
  `error{RESTORE_UNAVAILABLE}`, fresh-agent
  `create.failed{SESSION_RESERVED, retryable: true}`). Same-kind WS
  terminal contention keeps the existing D8 `SESSION_RESERVED` semantics.
  The table must expose enough holder/owner kind information (including
  for poisoned keys) for each door to make this mapping exactly; the
  barrier suite asserts exact codes, not mere refusal. *(D2, FE-R2-3,
  FE-R3-7)*
- **I-4 (discovered collision: refuse + hold + alarm, never adopt, never
  kill).** A discovery-time claim is idempotent **only** when the caller
  presents its own prior owner token and it equals the live binding (kind
  AND epoch). Any other live owner — same kind or cross kind — or any
  poisoned key refuses atomically; the refusal installs a conflict hold
  for the refused claimant **in the same lock scope** (deduped per holder
  identity), leaves the process running (D3), and fires the alarm surface
  (I-28/I-29). A key admits a new claim only when it has no lease, no
  binding, **and no conflict holds** — the original owner's exit alone
  never frees a key a refused writer is still using. Holds are released
  only by the refused process's own exit path. *(FE11, FE-R2-2, FE-R3-2,
  FE-R3-3)*
- **I-5 (epoch-conditional cleanup, no epochless APIs).** Every binding
  carries a table-minted, never-reused epoch inside its owner token; every
  clear/release presents the token and mutates only on kind-AND-epoch
  match (stale token → no-op, never a release). Conflict-hold releases are
  likewise hold-epoch-conditional. **No epochless clear/release API may
  exist** after Slice B0 — every production call site (including the codex
  watcher/`handle_kill` double-clear shape) migrates to the conditional
  form. A key string alone is never ownership proof. *(FE-R2-1, FE-R3-3)*
- **I-6 (atomic token/hold storage relative to exit hooks).** Storing a
  minted owner token or conflict-hold handle (on the terminal's registry
  row or the fresh-agent session entry) must be atomic with the claim's
  visibility to exit/kill paths: there is **no window in which an exit or
  kill hook can run for that terminal/session and miss a token or hold
  that a claim has already minted** — otherwise the binding or hold leaks
  forever. The in-slice design must state and test how this atomicity is
  achieved. *(R4-F1)*
- **I-7 (discovery rollback).** A freshly minted discovery claim is
  released (epoch-conditionally) on **any** post-claim failure —
  authorization rejection, publication refusal, terminal exited between
  claim and publish. An idempotent already-bound-to-caller answer is never
  rolled back (that binding predates the call). *(FE-R3-4)*
- **I-8 (atomic rebind transfer).** Live identity switches (codex fork
  rebind, claude/opencode signal A→B switch) release the old key's binding
  epoch-conditionally and claim the new key in **one lock scope**; the
  caller replaces its stored token with the returned one. A refusal on B
  still releases A (the process genuinely abandoned it) and conflict-holds
  B with the full alarm surface. Retired-lane rebinds (no live binding)
  skip the transfer. *(FE-R3-5)*

### Authorization

- **I-9 (live-owner first, self-exempt).** Authorization runs live-owner
  checks for **every** session-carrying candidate — including legacy
  resumes — strictly **before** existence mapping, so a live foreign owner
  refuses the launch even when existence is `Unknown`/`Absent`. The
  registry row join must exempt the candidate's own `terminal_id`
  (otherwise deferred re-authorization rejects itself against its own
  launch-hint row). This is defense-in-depth behind I-2, and it is what
  makes the sink safe for discovered candidates. *(LB13, FE-R3-6)*
- **I-10 (legacy existence dispositions, with freshness).** For legacy raw
  candidates only: `Present` → authoritative
  (`ExistenceValidatedLegacyResume`). `Absent` from a **fresh** index and
  `ProviderUnavailable` (missing provider root — it never warms on this
  machine) are **permanent** rejections. `Absent` from a **stale**
  snapshot and `Unknown` (any freshness — fresh `Unknown` is reachable
  from a warm index) are **deferrable**. The existence answer and its
  freshness bit MUST come from **one atomic snapshot read** (one lock
  acquisition in `freshell-sessions`) — composing separate peek+freshness
  calls can pair a stale answer with a fresh bit and turn a deferrable
  miss into a wrongful permanent rejection. Unknown-freshness answers are
  treated as stale (conservative). *(LB12, FE6, FE7, FE-R2-5, FE-R2-6)*
- **I-11 (deferred re-authorization, bounded).** A launched-but-unconfirmed
  legacy candidate is recorded as a marker owned by the sink and requeried
  on a bounded, capped-backoff schedule (small fixed attempt budget; each
  probe call itself kicks the detached index refresh, which is what makes
  the schedule converge — no new subscription API). First conclusive fresh
  answer wins: fresh `Present` publishes through the discovered pipeline
  (idempotently via the terminal's create-time admission token, per I-4);
  fresh `Absent` drops permanently with a structured warning; fresh
  `Unknown` **continues** the schedule; exhaustion drops with a structured
  warning. Markers are dropped on terminal exit. Fresh-`Absent` and
  `ProviderUnavailable` at create time are never deferred. *(LB12, FE7,
  FE-R2-6)*
- **I-12 (amplifier: admission and existence before any stub write).** The
  admission claim precedes the amplifier `ensure_session`/stub block (an
  admission loser must never write a provider stub), and legacy raw ids
  are existence-adjudicated with a **probe-only** lookup (never creates)
  before any stub write — ignoring zero-turn broker-shaped stubs so a
  leftover or just-written stub cannot self-authorize a caller-provided
  id. The stub itself still precedes `registry.create` (the events-lane
  resolver attaches at create time; that ordering is load-bearing:
  claim → stub → create). *(LB15, FE-R3-12)*

### Registry publication and create lifecycle

- **I-13 (terminal-id pre-reservation before PTY spawn).** Duplicate
  terminal ids are rejected by reserving the id under the registry lock
  **before any PTY exists**. Rejecting after spawn is unsafe even without
  map writes: a dropped uninserted PTY kills its child and its reader runs
  the ID-keyed exit hook, which would finish the **pre-existing** row.
  The reservation is replaced by the row on success and released on every
  failure path. *(FE-R3-9, LB4)*
- **I-14 (row and identity never observably split).** No identity-bearing
  terminal row may become visible to inventory, directory, activity
  `Created`, or exit retirement before its matching identity-registry row
  is published — one registry critical section for row insert + in-memory
  identity publication (create, running transition, and retired
  transition alike). Filesystem durability is awaited outside the lock.
- **I-15 (panic-free callbacks, abort on panic).** The synchronous
  publication callback runs under the registry's `std::sync::Mutex` and is
  a leaf in-memory write only: no broadcast, no ledger I/O, no await, no
  registry re-entry, no fallible work beyond cloning row fields. The
  registry invokes every publication callback through an abort-on-panic
  wrapper: an unwind out of the callback aborts the process **instead of**
  poisoning the mutex (a poisoned registry strands every PTY with no kill
  path; an abort closes every PTY master fd and lets supervision restart
  cleanly). Proven by a subprocess abort test plus
  registry-usable-after-error tests for every reachable failure. Registry
  locks are taken strictly before the admission lock, never inversely.
  *(FE-R1 critical, LB3, LB4)*
- **I-16 (finalization closed through settlement; Running re-check before
  Created).** The PTY exit hook must not run until create settlement
  (provider adoption, awaited durable write, announcement enqueue)
  completes. The finalization guard is held by the **settlement owner** —
  on the REST door a detached task that survives client aborts, never the
  HTTP handler future — and its drop on every success/error/unwind path
  opens the gate. Immediately before enqueueing any `Created`/`ui.command`
  announcement, the settlement owner re-checks under the registry that the
  row is still present and Running; a kill landing mid-settlement yields
  the retired shape instead (`terminals.changed` only, plus the
  epoch-conditional persistence cleanup) — never a `Created` announcement
  for a dead terminal. A client abort at any point still completes
  settlement, durable write, a deterministic fallback announcement, and
  gate release. *(LB6, FE-R1-9, FE-R3-10)*
- **I-17 (one settle/announcement mechanism for every ordering path).**
  All REST callers that create terminals — create, split, and respawn,
  **including the `pane_ops.rs` callers** — and the WS create path go
  through **one** shared settle/announcement mechanism. Its mechanics
  (channels, task ownership, handoff shape) are designed in-slice and
  reviewed, but the design MUST provide: the guard held through
  announcement by the settlement owner; the caller's UI-command/bookkeeping
  completing before the ordered announcement; deterministic, timeout-free
  behavior on every cancellation path including route abandonment (dropped
  caller ⇒ a defined fallback announcement shape, settlement always
  completes); and no lower helper announcing on its own. Round 3 proved a
  naive route-awaits-task shape deadlocks — the in-slice spec review must
  explicitly check the chosen design for circular waits. *(FE-R2-9,
  FE-R3-8, R4-F3)*
- **I-18 (enqueue-order claims only).** Every "before the HTTP response"
  ordering claim is an **enqueue** claim: frames are enqueued to the
  broadcast bus, in order, before the handler returns (ordinary create:
  `ui.command → terminals.changed → terminal.meta.updated`; deferred:
  `terminals.changed → terminal.meta.updated` with the command in the HTTP
  body; discovery: `associated → changed → meta`). Browser observation
  order is never claimed; the reconnect handshake inventory is the
  authoritative resync for missed frames (including the bounded-bus
  lagged-close case), and a client test proves eventual one-key
  convergence under adverse interleaving. *(LB17)*
- **I-19 (degraded durability is non-fatal and single-shot).** A degraded
  durable write never kills an otherwise successful terminal: the normal
  success response is returned and exactly one typed `durability.degraded`
  frame is surfaced per settled identity event. Disabled ledger, I/O
  failure, and blocking-task failure are machine-distinct.

### Retirement and exit

- **I-20 (Closed only on explicit close).** Durable ledger rows become
  `Closed` only on explicit user kill — today exactly the WS
  `terminal.kill` door. No REST route kills a PTY (pane/tab DELETEs keep
  PTYs; `DELETE /api/terminals/:id` only hides), so no REST code path may
  invoke explicit-close retirement; adding a REST kill door is out of
  scope. The explicit-close ledger retirement remains **awaited** by the
  kill handler before it completes (today's contract) — never weakened to
  fire-and-forget. *(LB7, FE-R1-8, FE-R2-8)*
- **I-21 (pending markers deleted on every exit).** Epoch-keyed pending
  markers are deleted (epoch-guarded) on **every** exit cause — natural
  exit included (current production behavior, preserved through the binder
  migration). Only ledger `Closed` retirement is explicit-close-only.
  *(FE-R2-7, LB8)*
- **I-22 (natural exit leaves Bound).** Natural PTY exit, auto-resume
  settlement, and graceful shutdown leave ledger rows `Bound` (a
  still-Bound row is auto-resume's not-closed signal). In-memory identity
  is marked retired-but-retained on every exit so the trusted
  retired-signal lane keeps working. New exit machinery must not race or
  suppress current `auto_resume_cancels`/settle-frame behavior. *(LB7)*
- **I-23 (retired-OpenCode missing-row lane).** Explicit kill removes the
  registry row, and the retained OpenCode signal may still rebind
  afterwards: retired-signal publication must permit an **absent** registry
  row when the retained retired identity matches the exact
  previous-session CAS — updating identity registry (retired) and ledger
  without fabricating a live row, registry metadata, `terminal.created`,
  or live activity. *(LB9)*
- **I-24 (publication-time ownership record drives retirement).** The sink
  receives, **at publication time**, everything retirement needs — the
  published (provider, session id, terminal id, create-request id) **and
  the admission identity/epoch** — kept as an immutable per-terminal
  record (replaced wholesale on rebind, removed when retirement cleanup
  settles). Retirement and admission release resolve their expected values
  from this record, **never by reading live registry/ledger state** (the
  kill path removes the row first; reading the current ledger row is
  tautological). Delayed old cleanup against a replacement owner is a
  no-op. *(FE-R3-11, R4-F2, LB8)*
- **I-25 (one pre-spawn ledger exception: PIN2).** No pre-spawn ledger
  write may exist except the landed PIN2 minted-fresh-Claude binding
  (awaited, with its spawn-failure delete twin) — the id is minted by this
  create, so no competing writer can exist and the crash residue is one
  inert row. None may be added for resumes, other providers, or discovered
  ids. The sink absorbs the PIN2 pair behind typed methods so the
  exception stays visible and testable. *(LB5, FE-R1-3)*

### Wiring

- **I-26 (one pointer-identical sink, boot-asserted).** One production
  sink instance is wired into all five consumers (the four fresh-agent
  states and `WsState`), asserted at boot: each consumer exposes a
  wired-check, and boot asserts all five wired AND pointer-identical
  (`Arc::ptr_eq`) to the constructed sink. Set failures are loud (the
  current silent `let _ = OnceLock::set(…)` pattern must not remain the
  only guard). The sink owns the shared revision increment and
  announcement dedupe, so a forked instance would fork the revision
  stream. *(LB2, FE-R2-10)*
- **I-27 (no Arc cycle).** The fresh-agent owner probes capture `Weak`
  state projections (upgrade per call, answer false on failure); a
  teardown test proves the sink and states deallocate when external
  handles drop. The production sink lives in an importable crate
  (`freshell-ws` — the server crate is bin-only and cannot be imported by
  tests; #584's binder placement independently confirmed this), gains no
  server-only dependency, and the server crate shrinks to construction
  glue. The landed binder is absorbed and deleted — no parallel identity
  write path remains. *(LB1, LB18, FE-R1-3)*

### Protocol and client surface

- **I-28 (client-consumed frames follow the FULL contract).** Every new
  server→client frame that the client consumes goes through the complete
  protocol contract: declared in `shared/ws-protocol.ts`, contract
  regeneration run (`npm run contract:generate` with the diff committed),
  and promotion into the protocol crate's `SERVER_MESSAGE_TYPES`
  inventory with shape pins. **The collision alarm frame is NOT an
  extension-lane frame** — revision 4's `EXTENSION_SERVER_MESSAGE_TYPES`
  placement is superseded: the extension lane is for frames the client
  does not consume, and I-29 requires the client to consume this one.
  *(R4-F4)*
- **I-29 (collision alarm genuinely user-visible).** The discovered-
  collision alarm has four proven surfaces: (a) an invariant-level ERROR
  log (same mechanism as the existing D8 duplicate-session alarm, which is
  log-only); (b) the collision frame per I-28, emitted exactly once per
  refusal by the shared discovery/rebind path; (c) a **user-visible,
  App-mounted, dismissable banner** — client state + a banner component
  actually mounted in the app shell (following the
  `ReconcileWarmingBanner`/`TerminalExitBanner` precedents) with a
  component test proving it renders from the frame — plus a note in the
  `docs/index.html` UI mock; (d) the refused terminal never receives
  published identity, so the sidebar never presents it as the session's
  owner. *(FE-R3-1, R4-F5)*
- **I-30 (read models project authority only, with the D1 carve-out).**
  `/api/terminals` projects `sessionRef` only from the identity registry
  for claude/codex/opencode/amplifier and retains the
  `mode + resume_session_id` synthesis verbatim for gemini/kimi; pane
  reconcile no longer echoes an unpublished promoted claim as the pane's
  `session_ref` for the four providers (gemini/kimi echo retained). A
  legacy-unknown restore therefore yields exactly one sidebar key. The
  projection change lands only after every authoritative publisher is
  wired. No client selector change; no Node server change. *(LB11, LB16)*

### Provider launch and door behavior

- **I-31 (provider launches preserved).** Fresh Claude: minted UUID,
  `Start`, `--session-id`. Explicit Claude: `--resume`. Fresh Amplifier:
  minted UUID, pre-created stub, `Resume`, existing effective-cwd rules.
  Explicit Amplifier: existing stub/restore checks (reordered per I-12).
  Fresh OpenCode: no session id in argv. Explicit OpenCode: `--session`.
  Codex: existing managed/plain decisions; fresh Codex stays
  rollout-locator-discovered. Preserve create dedupe, spawn-gate
  ownership, detached settlement, managed adoption, locator arming,
  amplifier stub GC, restore-key replay, pane/tab bookkeeping, and PTY
  process-group kill discipline. Pane-ledger I/O stays on
  `spawn_blocking`.
- **I-32 (invalid REST shapes rejected before spawn).** A parsed
  `sessionRef` whose provider ≠ mode → 400
  `SESSION_REF_PROVIDER_MISMATCH` (all four providers); claude
  `restore: true` with no accepted ref and no resume id → 422
  `CLAUDE_RESTORE_UNRESOLVED` (mirror of the WS ladder). The amplifier
  restore-bare carve-out is pinned as deliberate. Today both invalid
  claude shapes launch bare unresumable processes. *(FE-R1-10)*
- **I-33 (D5 legacy-WS removal).** Session-identity-carrying
  `terminal.create` on a non-negotiated connection is rejected before any
  spawn work with a deterministic protocol-mismatch error instructing a
  refresh; the legacy check-then-spawn path for session-carrying creates
  is removed. Plain-shell and identityless legacy creates remain
  unchanged. *(D5)*

### Process invariants

- **I-34 (attach doors in the acceptance gate).** The barrier/admission
  acceptance suite must cover the **attach** doors — fresh-agent attach
  for claude/codex/opencode racing terminal claims on the same key — not
  only the create doors. Every door I-2 enumerates appears in the barrier
  matrix or has a deterministic admission regression. *(R4-F6)*
- **I-35 (honest commit messages).** Every commit message accurately
  describes the full delta of its commit — nothing aspirational, nothing
  omitted that changes behavior. A commit that touches N concerns says so.
  Slice code review includes the commit message. *(R4-F7, R4-F8)*
- **I-36 (no vacuous greens).** Every focused test command must
  demonstrably select at least one test (`running 0 tests` /
  `0 passed; 0 failed` is a command bug — treat as RED). Fully-qualified
  filters for `--exact`; verify Playwright/vitest summaries show the
  expected specs actually ran; real-provider vitest runs need the server
  vitest config or they select nothing. *(FE-R2-11/13/14)*

---

## TDD discipline (applies to every slice)

- Red/green/refactor with **runtime reds only**: every slice lands its
  test surface together with a compiling minimal stub, so each RED is a
  genuine assertion failure, never a missing-symbol compile error.
- No commit contains a red test. No Cargo target is left uncompilable at
  any commit boundary (when a new enum variant breaks exhaustive matches
  downstream, every match gains its arm in the same step). Trait growth
  uses temporary default bodies flipped to required methods within the
  same slice.
- Tests use barriers/channels for interleaving control, never sleeps;
  injected temp directories and fake provider executables only; never the
  user's provider homes, pane ledger, signal roots, or the evidence
  bundle.
- Test obligations below are named by **behavior**. The implementer names
  the test functions; the slice reviewer checks each obligation has a
  test, each test fails before the implementation (where a red phase is
  declared), and each focused command selects it (I-36).
- Acceptance pins over already-landed behavior (Slice E1 verification,
  Slice I pins) are green-on-land by design — no red phase is faked for
  them.

## Review gates

- **Fresh-baseline gate (before the first implementation commit):** the
  gate targets **current `origin/main` at implementation start**, never a
  SHA written in this plan (pins go stale; `c5e9fdaa` is only the value as
  of this revision). Fetch; if main moved, rebase and check
  `git diff <old-base>..origin/main -- crates` — if non-empty, re-validate
  the affected facts before proceeding. Run the repo-supported baseline on
  that base per `AGENTS.md` (broad suites through the shared test
  coordinator; never kill a foreign holder), record the result, and stop
  if the base is not green. No recorded baseline exists yet for any
  current base.
- **Per-slice spec review (before implementation of the slice's design):**
  once the slice's concrete design exists (types, lock scopes, task
  ownership, channel shapes — whatever the slice needs), review it against
  this plan's invariants and the slice's obligations **before** building
  it out. For concurrency designs (B0, B, E2/H settle mechanism) the spec
  review explicitly checks lock ordering, atomicity of token storage
  (I-6), and absence of circular waits (I-17).
- **Per-slice code review (before commit):** review the slice's diff
  against the invariants, the test obligations, and the commit message
  (I-35). Fix findings before committing.
- **Final Fresh Eyes:** after Slice J's gates, run independent Fresh Eyes
  review on the complete worktree-vs-base delta, up to five rounds or
  until pass, committing fixes between rounds. If the fifth round fails,
  report loudly and do not claim readiness.

## Safety boundaries

- Work only in
  `/home/dan/code/freshell/.worktrees/rest-codex-terminal-identity` on
  branch `fix/rest-terminal-identity-publication` (docs-only commits atop
  `origin/main`; `c5e9fdaa` as of this revision).
- Do not build, deploy, stop, or restart live port 3002. Do not create a
  PR, push, merge, or remove the worktree without explicit approval.
- Never touch the preserved incident evidence bundle
  (SHA-256-manifested, 132 files).
- Rust production server only; do not add Node server behavior. Do not
  modify `src/store/selectors/sidebarSelectors.ts`.
- Replace this plan in place; do not create competing provider-specific
  plans. Main's `2026-07-29-rest-terminal-session-identity.md` is #584's
  historical document — never edit it.

---

# Implementation Slices

Slice order: A → B0 → B → C → D → E1(verify) → E2 → F0–F5 → G → H → I → J.
B0 is deliberately early (D4). G is deliberately after E2+F (the projection
removal's precondition is that every authoritative publisher is wired).
Each slice ends with spec review → implementation → code review → commit
(I-35 applies to every commit subject and body).

Master checklist (check a slice only when its obligations, reviews, and
commits are all done):

- [ ] Preflight (fresh-baseline gate)
- [ ] Slice A — provenance types + classifier
- [ ] Slice B0 — SessionAdmission + REST-door fix + legacy-WS removal
- [ ] Slice B — atomic registry publication + finalization guard
- [ ] Slice C — epoch-guarded ledger + retired-aware upsert
- [ ] Slice D — production sink + boot wiring
- [ ] Slice E1 — verify landed predicate (no commit)
- [ ] Slice E2 — REST provenance-aware publication + binder deletion
- [ ] Slices F0–F5 — discovered/rebind/deferred publication
- [ ] Slice G — authority-only read models
- [ ] Slice H — ordered announcement + collision alarm surface
- [ ] Slice I — integration / real-provider / browser acceptance
- [ ] Slice J — whole-branch verification, reviews, report

- [ ] **Preflight:** run the fresh-baseline gate (above). Verify the landed
  E1 predicate test runs and passes (fully-qualified filter, nonzero
  selection — I-36). Study `git log --stat <plan-base>..origin/main` for
  drift since this revision. Record baseline evidence for the report.

---

### Slice A — Provenance types + pure classifier

**Intent:** land the typed vocabulary (candidate source, provenance,
visibility, exit cause, candidate/authorized identity, rejection reasons,
durability results, pending identity, announcements) and a pure classifier
that decides a create's candidate source from mode + accepted ref + raw
resume id. Types only — no behavior change anywhere.

**Scope:** `crates/freshell-freshagent/src/identity_sink.rs` (+ re-exports
in `lib.rs`). Nothing else.

**Invariants:** vocabulary for I-9/I-10 (the four provenance values and
the permanent-vs-deferrable rejection distinction, with
`ProviderUnavailable` documented **permanent**); D1 scoping.

**Test obligations (RED first — classifier stubbed):**
- Classifier truth table: accepted matching refs classify for all four
  providers; a cross-provider ref classifies as nothing; a raw resume id
  classifies as legacy **only** for the four modes; gemini/kimi/shell and
  every other mode classify as nothing (D1 pins). Compare the classifier's
  option result directly.

**Done:** types exported; classifier green; workspace compiles.
**Commit subject:** provenance types and pure classifier — nothing more.

---

### Slice B0 — Shared cross-kind `SessionAdmission` + REST-door fix + legacy-WS removal

**Intent:** build the one admission table (I-1) and route every door
through it (I-2), closing the deterministic REST two-writer hole first
(D4); migrate both existing lease stores to facades with epoch-carrying
owner tokens (I-5) and conflict holds (I-4); remove the legacy WS
session-carrying create path (I-33, D5); prove admission with the barrier
acceptance suite including attach doors (I-34).

**Scope:** new `crates/freshell-terminal/src/session_admission.rs`;
`crates/freshell-terminal/src/{lib,registry}.rs`;
`crates/freshell-freshagent/src/{session_lease,claude,codex,opencode_ws,terminal_tabs}.rs`;
`crates/freshell-ws/src/{terminal,auto_resume}.rs`;
`crates/freshell-server/src/main.rs` (one instance, injected);
new `crates/freshell-ws/tests/cross_kind_admission.rs` (extend the
`cross_kind_liveness.rs` / `rest_ws_shared_gate.rs` harness patterns).
Out: any publication/sink work (later slices).

**Invariants proven:** I-1 through I-8 (table-level), I-12 (claim-before-
stub ordering half), I-33, I-34, plus the facade-preservation half of I-1.

**Design notes for the spec review (constraints, not mechanics):** one
mutex over leases + bindings + holds; epochs minted from one table-global
monotone counter, never reused; registry inner locks taken and released
before the admission lock (the existing acyclic discipline); the
cross-kind claim answer must flow through the registry facade's claim
result type so the WS/REST doors and `auto_resume`'s exhaustive matches
handle it in the same step (auto-resume answers "do not respawn" for a
fresh-agent-owned session); the kill-tree machinery in `session_lease.rs`
stays — only map storage moves.

**Test obligations:**
- Table unit pins (staged interleavings, no sleeps): exactly one
  `Acquired` under racing claims; claim-across-complete answers bound;
  cross-kind bindings never adoptable; held/bound/poisoned answers expose
  holder kinds (I-3); epochs are unique and monotone per binding;
  discovered-claim idempotency **only** with a matching prior token (kind
  AND epoch) — no prior token never adopts, any different owner refuses
  (I-4); refusal installs a deduped hold and poisons the key; hold release
  is hold-epoch-conditional and stale releases are no-ops; a poisoned key
  stays closed after the owner's exit until the hold releases; rebind
  atomically frees old/protects new, refusal still frees old, a stale old
  token never releases a replacement (I-8, I-5); stale-epoch clears are
  no-ops against replacements (the codex double-clear shape, at table AND
  facade level); conn-scoped release touches only terminal holders;
  force-release requires a confirmed kill.
- Facade migration: both existing suites (the fresh-agent lease suite and
  the D8 registry claim tests) stay green with only mechanical
  token-threading edits; **no epochless clear/release API survives** and
  every production cleanup call site presents a stored token (I-5, I-6).
- REST-door regressions (deterministic RED today): a REST terminal resume
  of a live fresh-agent-owned session answers 409 with **zero** PTY
  spawns, for both the parsed-ref and legacy-raw rungs.
- Amplifier: an admission loser never writes a provider stub (I-12).
- Auto-resume: a fresh-agent-owned session is never auto-respawned.
- D5: a legacy-connection session-carrying create (parsed ref AND raw id)
  is rejected with the deterministic refresh error before any spawn work;
  a legacy-connection plain-shell create still works.
- **Barrier acceptance (the LB14 gate):** for each of claude/codex/
  opencode, in WS×fresh-agent and REST×fresh-agent pairings, **and for the
  fresh-agent attach door racing a terminal claim (I-34)**, release
  barriers in both orders plus a simultaneous variant and assert: exactly
  one winner; the loser's **exact** structured error per door and
  contention kind, including same-kind and poisoned-key controls (I-3);
  exactly one writer post-hoc (provider transcript + rows); loser-retry
  convergence after winner exit; and the poisoned-key retry shape — the
  owner exits, the key stays closed while the refused process runs, and
  frees only after the refused process exits (I-4). These prove admission
  atomicity + containment; they never claim the two already-running
  discovered writers are undone.

**Done:** hole closed with regressions; barrier suite green; both facades
preserved; every door claims; no epochless cleanup anywhere.
**Commit guideline:** split into table / facade+REST-fix / D5-removal /
barrier-suite commits, each subject naming exactly what that commit did.

---

### Slice B — Atomic registry publication with finalization guard

**Intent:** give `TerminalRegistry` the atomic create-with-publication and
running/retired identity-transition primitives the sink will drive:
id pre-reservation (I-13), one-critical-section row+identity publication
(I-14), the abort-on-panic callback wrapper (I-15), and the finalization
guard the settlement owner holds (I-16's registry half).

**Scope:** `crates/freshell-terminal/src/registry.rs` only.

**Invariants proven:** I-13, I-14, I-15, and the guard/gate half of I-16.

**Design notes:** the running-transition primitive must support: reject
missing/non-running rows; idempotent already-published; first discovery
requires no current and no expected id; rebind requires current == expected
(CAS); everything else conflicts. The retired-transition primitive
requires an existing non-running row with the exact expected previous id
and never fabricates rows (the sink-level missing-row lane, I-23, lives
above the registry). The legacy `create` delegates unchanged.

**Test obligations (RED against naive stubs):**
- Row hidden until the identity callback completes; immediate exit waits
  for the guard; the exit hook cannot run before caller settlement
  completes.
- Publisher panic **aborts the process** (subprocess re-exec test: assert
  abnormal abort termination, not an ordinary unwind or poisoned-mutex
  panic); registry remains fully usable after a duplicate-id rejection
  (no poisoning, no leftover row or reservation).
- Duplicate id rejects at reservation time with zero spawns for the loser
  and the pre-existing terminal undisturbed (still Running, hook never
  invoked); spawn failure releases the reservation and an immediate retry
  succeeds.
- Discovered publication is atomic with the callback; publication after
  exit is refused with zero callbacks; rebind CAS honored; stale previous
  id cannot overwrite; retired rebind updates identity without touching
  exit status and requires the expected previous id; the legacy create
  wrapper preserves existing behavior.

**Done:** all obligations green; `-p freshell-terminal --all-targets`
green. **Commit subject:** atomic registry publication primitives.

---

### Slice C — Epoch-guarded ledger primitives + retired-aware identity upsert

**Intent:** the two durable-store primitives everything above needs:
epoch-conditional ledger retirement / pending deletion (I-5's persistence
half, I-21), and a single-lock retired-aware identity upsert so retired
publication is never transiently visible as live.

**Scope:** `crates/freshell-ws/src/pane_ledger.rs` (+ its tests file) and
`crates/freshell-ws/src/identity.rs`. Two commits.

**Invariants proven:** persistence halves of I-5/I-21/I-24; the
no-transient-live-row rule for I-23's lane.

**Test obligations (RED against stubs):**
- Ledger retirement mutates only the matching (provider, session,
  terminal, create-request) owner; a delayed stale cleanup cannot retire a
  replacement owner (barrier-staged); pending deletion requires the epoch
  match; an enabled binding reloads after an ordinary restart.
- A retired identity upsert is never visible in the live identity list
  (never implemented as upsert-then-retire across two lock takes).

**Done/commits:** one commit per primitive, subjects scoped exactly.

---

### Slice D — Production sink in `freshell-ws`, trait extension, boot wiring

**Intent:** extend `PaneIdentitySink` with the terminal-identity methods
(authorize / publish-memory / persist / pending / retire / defer / announce
/ the typed PIN2 pre-spawn pair), implement the production sink in
`freshell-ws` (I-27), implement authorization ordering (I-9, I-10) over an
atomic snapshot+freshness probe read, add the publication-time ownership
record (I-24), awaitable retirement (I-20/I-21/I-22), deferred-marker
storage (I-11's storage half), announcement/revision ownership (I-18/I-19),
and wire one pointer-identical sink into all five consumers with boot
assertions (I-26).

**Scope:** `crates/freshell-freshagent/src/identity_sink.rs` (trait +
extended fake, defaults flipped to required in-slice);
new `crates/freshell-ws/src/identity_sink.rs`;
`crates/freshell-ws/src/{lib,existence}.rs`;
`crates/freshell-freshagent/src/{lib,claude,codex,opencode_ws}.rs` (loud
setters/wired-checks); `crates/freshell-server/src/{identity_sink,main,existence}.rs`;
`crates/freshell-sessions/src/directory_index.rs` (the one-lock
snapshot+freshness read). Out: any call-site migration (E2/F).

**Invariants proven:** I-9, I-10 (probe + authorization), I-19, I-20/21/22
(sink semantics), I-24, I-25 (typed PIN2 pair), I-26, I-27.

**Design notes:** `WsState` gaining the sink field has a large
struct-literal blast radius across the ws test files — provide a cheap
always-compiled test-helper constructor so each literal is a one-line
change, and let `cargo test -p freshell-ws --all-targets` be the gate that
catches any missed site. No `Default`/builder for `WsState`. The
freshagent fake sink is `#[cfg(test)]` and invisible to `freshell-ws`;
plan the ws-side test double for Slice F0 accordingly.

**Test obligations (RED against default-body stubs):**
- Authorization: live claude/codex/opencode fresh-agent owners reject;
  live-owner rejection precedes existence even when existence is Unknown
  (I-9); the row join exempts the candidate's own terminal while a foreign
  row still rejects (I-9); amplifier uses the no-runtime probe arm; legacy
  adjudication ignores zero-turn broker stubs (I-12); stale-snapshot
  Absent defers while fresh Absent is permanent; ProviderUnavailable is
  permanent (I-10).
- Freshness atomicity: the sessions-crate read returns items + freshness +
  generation from one guard acquisition, proven under concurrent
  republishes (no stale items paired with another generation's freshness);
  the server probe consumes only that read (I-10).
- Durability: memory publication is synchronous and filesystem-free;
  bindings reload from a fresh ledger instance; disabled ledger is typed
  degraded; write vs join failures are machine-distinct (I-19).
- PIN2: the pre-spawn minted-claude write creates the row and its delete
  twin removes it (ported binder pin, I-25).
- Retirement: natural exit retires memory but leaves the ledger Bound AND
  deletes the pending marker (I-21/I-22); explicit close retires the
  ledger through the epoch guard and its completion is awaitable and
  resolves only after the blocking cleanup settles (I-20); retirement
  resolves owner values from the publication-time record even after the
  registry row is removed, and a delayed retirement against a rebound
  replacement is a no-op (I-24).
- Boot: one pointer-identical sink asserted across all five consumers;
  teardown proves no Arc cycle (I-26, I-27).

**Done:** all green; every `WsState` construction site compiles; server
boots the assertions. **Commit subject:** shared terminal identity sink
with typed durability and boot wiring (one commit; the subject must not
claim any call-site migration — I-35).

---

### Slice E1 — Fresh-Claude preallocation predicate — **LANDED in #584 (verify only)**

- [ ] Verify `freshell_platform::should_preallocate_fresh_claude` and its
  truth-table test pass with a fully-qualified focused filter and nonzero
  selection (I-36). No work, no commit.

---

### Slice E2 — REST provenance-aware publication (absorbs the landed binder)

**Intent:** make the REST door provenance-aware: rejection ladder (I-32),
candidate → authorize → atomic publish → awaited persist for every
authoritative shape, deferred/permanent legacy lanes (I-10/I-11 storage),
scoped pane promotion (I-30's REST half), cause-aware retirement, the
settlement-owner guard behavior on the REST door (I-16), and absorption +
deletion of the provenance-blind binder (I-27's no-parallel-path half).

**Scope:** `crates/freshell-freshagent/src/terminal_tabs.rs` (+ `lib.rs`
binder wiring removal); delete
`crates/freshell-ws/src/pane_identity_binder.rs` and the binder trait in
`crates/freshell-terminal/src/registry.rs`; ported binder unit tests move
into the ws sink tests; `crates/freshell-server/src/main.rs` (binder
wiring out). Out: the ordered-announcement mechanism's client-visible
ordering tests (Slice H proves I-17/I-18 end-to-end; E2 must not paint it
into a corner — design the settle handoff once, here or in H, per I-17's
constraints, and have the spec review check it).

**Invariants proven:** I-12 (REST ordering end-to-end), I-16, I-25 (REST
lane), I-30 (pane promotion), I-31, I-32; binder deletion for I-27.

**Test obligations (runtime REDs; observe the injected fake sink — this
crate cannot import the production ledger, so real-ledger persistence
proof lives in the ws targets and Slice I):**
- Fresh REST Claude publishes its minted identity through the sink; the
  four explicit-ref providers record candidate → authorize →
  publish-memory → persist with exact refs and `AcceptedSessionRef`
  provenance; fresh amplifier keeps stub-before-spawn with the minted UUID
  in resume position.
- Amplifier legacy raw id is probed before any stub write; a
  never-existing raw id is NOT re-stubbed (rescope the old silent-restub
  expectation to previously-authorized ids and record the delta).
- A raw resume publishes **only** on Present (genuine RED — the landed
  binder publishes everything); Unknown/stale-Absent launches with a
  deferred marker and no published identity and no pane promotion;
  fresh-Absent/ProviderUnavailable launches with a permanent structured
  warning and no marker.
- Rejection ladder: cross-provider ref → 400 before spawn; unresolvable
  claude restore → 422 before spawn; amplifier restore-bare carve-out
  pinned as deliberate (I-32).
- Pane-content `sessionRef` stamped only from authorized identity for the
  four providers; gemini/kimi promotion untouched (D1).
- Spawn failure deletes the PIN2 pre-spawn row, writes nothing else, and
  frees the admission lease; immediate exit retires only after atomic
  publication; natural exit passes natural-exit cause (never explicit
  close — no REST path may, I-20) and deletes the pending marker.
- Client abort at any point still completes settlement, the durable
  write, a deterministic fallback announcement, and guard release (I-16);
  a kill landing mid-settlement yields the retired shape — no
  Created/ui.command, changed-only, epoch-conditional cleanup (I-16).
- Split and respawn share the known-identity pipeline (landed mint pins
  stay green).
- Binder absorption: all four binder call sites migrated onto the sink,
  ported unit tests green, module + trait + wiring deleted, and the landed
  integration pins stay green — except any pin asserting unvalidated
  raw-id publication, which is deliberately rescoped and recorded.

**Done:** no parallel identity write path; route matrix green; landed pins
green or recorded-rescoped. **Commit subject:** REST provenance-aware
publication absorbing and deleting the binder (say both halves — I-35).

---

### Slice F — Discovered/rebind publication through the shared sink

All `freshell-ws`; six commits (F0–F5). Shared helpers live in one new
focused module (e.g. `terminal_identity_publication.rs`); association
write tails and their tests stay in their existing association modules.

- [ ] **F0 — recording sink test double.** A ws-local recording sink
  (seeded from the always-compiled test-helper sink) so F-slices can
  observe call order. Commit: test double only.

- [ ] **F1 — OpenCode locator + the discovery helper + the collision
  frame.** **Intent:** one shared discovered-publication helper
  implementing claim → authorize → atomic registry transition →
  publish-memory → store token → awaited persist (binding then
  epoch-guarded pending delete) → announce, with I-7 rollback on every
  post-claim failure and I-6 token/hold storage; the refusal arm fires the
  full alarm surface; migrate the OpenCode locator write tail onto it
  (locator arming/tick/root-resolution/single-bind rules unchanged).
  **Protocol obligation (I-28):** the collision frame is added through the
  FULL contract — `shared/ws-protocol.ts`, contract regeneration with the
  committed diff, `SERVER_MESSAGE_TYPES` promotion, shape pins. **Test
  obligations:** fresh OpenCode argv has no `--session` and records an
  epoch-keyed pending marker; discovery flows through the helper in the
  exact call order with the minted token stored; discovery after exit
  publishes nothing; a claim rolls back when the terminal exits between
  claim and publish, and on authorization rejection — while an
  already-bound-to-caller answer is never rolled back (I-7); a live
  fresh-agent owner refuses; a refusal emits exactly one collision frame
  plus the invariant-level ERROR and stores the hold handle on the row;
  the refused terminal's exit releases its stored hold and frees the key
  (I-4, I-6). After F1 lands, extend the B0 barrier poisoned-key test to
  assert the frame end-to-end. **Commit:** helper + locator migration +
  frame, subject naming all three.

- [ ] **F2 — Codex discovery/fork.** **Intent:** codex first adoption
  through the discovery claim, fork rebind through the atomic rebind
  transfer (I-8), write tail through the helper; rollout lineage, fork
  watch, previous-session, and activity-hub calls preserved after a
  successful publish. **Test obligations:** existing codex association/
  fork pins gain sink-order assertions (RED while the old fan-out
  bypasses the sink); after a fork rebind A→B, A's key reopens, B answers
  bound with the new token, and the row-stored token is B's.

- [ ] **F3 — Signal rebinds (LB9).** **Intent:** OpenCode and Claude
  signal rebind tails through the shared publishers; live A→B switches
  through the rebind transfer; the retired missing-row lane preserved
  (I-23). Guard ladders, Claude's no-first-bind-via-signal policy,
  OpenCode first-bind arbitration, retired re-retire, and
  previous-session fields unchanged. **Test obligations:** retired signal
  rebind stays retired and announces layout identity; a retired rebind
  with an absent registry row uses the retained-identity CAS (I-23); a
  live signal switch transfers the admission binding atomically (I-8).

- [ ] **F4 — WS known creates + explicit close.** **Intent:** the WS
  create path uses the same predicate/candidate policy and the atomic
  create-with-publication with the settlement-owner-held guard and the
  shared announcement mechanism (I-17); `handle_kill` switches to
  explicit-close retirement and **awaits** the completion (I-20). No
  change to request-id dedupe, attach/adopt branches, or launch args.
  **Test obligations:** a WS known create publishes through the shared
  sink in order (RED while WS uses its separate fan-out); the kill
  handler does not finish while the retirement job is blocked (I-20);
  auto-resume e2e pins stay green (I-22).

- [ ] **F5 — Deferred re-authorization worker (I-11).** **Test
  obligations (all five, driven by an injected clock/attempt hook — no
  sleeps):** an Unknown legacy resume authorizes late on fresh Present
  and publishes through the discovered pipeline with
  `ExistenceValidatedLegacyResume` — this fixture inherently proves I-9's
  self-exemption (the candidate's own Running row carries the launch hint
  throughout) and I-4's prior-token idempotency (the worker presents the
  create-time token and asserts the idempotent answer); stale-Absent
  defers then fresh-Absent drops permanently with a structured warning;
  fresh-Absent and ProviderUnavailable are never deferred; fresh-Unknown
  answers continue the bounded schedule; exhaustion drops the marker with
  a structured warning and publishes nothing. Markers drop on terminal
  exit. Refactor pass after F5: delete superseded duplicated
  broadcaster/resolver helpers if no call sites remain — no parallel
  paths.

---

### Slice G — `/api/terminals` authority-only projection + read-model alignment

**Intent:** with every authoritative publisher wired, make the read models
project authority only (I-30): the directory synthesis becomes
identity-registry-only for the four providers (gemini/kimi synthesis
retained verbatim), and reconcile stops echoing unpublished promoted
claims for the four providers (gemini/kimi echo retained).

**Scope:** `crates/freshell-server/src/terminals.rs`,
`crates/freshell-ws/src/reconcile.rs`. No pane-payload promotion here; the
registry-row join for pane→terminal attachment is untouched (launch-fact
consumer).

**Test obligations:** the directory does not invent a `sessionRef` from an
unpublished `resume_session_id` (RED today); gemini/kimi synthesis pinned;
the existing codex projection pins stay green; an unpublished
four-provider promoted claim is not echoed as the pane's session ref;
gemini/kimi echo pinned; a one-sidebar-key read-model regression proves
the pane payload and directory row cannot disagree for a legacy-unknown
restore (the existing selector tests stay untouched and green).

**Done:** projection + echo scoped; client selector untouched.

---

### Slice H — Ordered REST announcement + collision alarm client surface

**Intent:** prove the enqueue-ordering contract (I-18) end-to-end through
the **one** settle/announcement mechanism shared by every REST caller —
create, split, respawn, including the `pane_ops.rs` callers — and the WS
path (I-17); land the client half of the collision alarm (I-29); land the
incident client regression and the adverse-interleaving convergence test.

**Scope:** `crates/freshell-freshagent/src/terminal_tabs.rs` (+
`pane_ops.rs` if its callers need routing onto the shared mechanism),
`src/lib/terminal-invalidation-handler.ts`, a new banner component
mounted in the app shell, `docs/index.html` (mock note),
`test/unit/client/components/App.ws-bootstrap.test.tsx`, the handler and
component tests. Do not modify the sidebar selectors.

**Test obligations:**
- Server enqueue order (RED — the route currently emits only
  `ui.command`): ordinary create enqueues ui→changed→meta before
  returning; deferred create enqueues changed→meta with the command in
  the body only; an identityless create emits changed without meta;
  degraded durability yields HTTP success plus exactly one typed degraded
  frame (I-18, I-19).
- Every REST creating caller — create, split, respawn, pane_ops — goes
  through the one mechanism (assert at the seam; no caller announces on
  its own) with deterministic route-abandonment behavior (I-17; the
  cancellation tests live in E2 — keep them green).
- Client incident regression: seed the exact incident ids
  (`019f9cb3-…`/`8f673dee-…`) with a stale cached directory row and the
  open pane; deliver changed+meta; one debounced directory fetch; the
  sidebar converges to the single canonical key with same-revision
  replacement of the stale row.
- Adverse interleaving: apply the HTTP response before the frames; assert
  bounded transient duplication and eventual one-key convergence (I-18).
- Collision alarm client surface (I-29): the frame dispatches into client
  state; the banner component renders from that state, is dismissable,
  names provider/session/writers, and is **mounted in the App shell**
  (component test + mounting assertion); `docs/index.html` mock updated.

**Done:** ordering + alarm surfaces proven; selectors untouched.
**Commit guideline:** server-ordering and client-surface halves may be
separate commits; each subject states exactly its half (I-35).

---

### Slice I — Merged integration, real-provider, and browser acceptance

Acceptance pins over already-green behavior — green-on-land is correct
here; no red phase.

**Scope:** new `crates/freshell-ws/tests/rest_terminal_identity.rs`
(merged REST/WS/provider-matrix suite importing the **production** sink —
possible because of I-27's crate placement);
`test/integration/real/coding-cli-session-contract.test.ts`;
new `test/e2e-browser/specs/rest-terminal-identity-rust.spec.ts`;
`test/e2e-browser/playwright.config.ts`.

**Obligations:**
- The exact `gf ui` incident pin: seed the old stale binding, POST the
  exact incident create, assert one process, one tab/pane, and directory +
  identity registry + live ledger + fresh-ledger reload all naming the
  exact Codex ref, with ordered enqueue observed by a test subscriber.
  Persistence assertions cover observable facts only (rows + exact
  sessionRef) — no schema stores provenance and none is added; provenance
  is asserted at the typed seams (E2/D tests). This pins on top of #584's
  landed pins.
- Provider matrix: explicit refs publish for all four providers with a
  reloaded-production-ledger equality check (the assertion the freshagent
  unit seam cannot host); fresh Claude preallocated and restart-durable;
  fresh Amplifier prestubbed and restart-durable; fresh OpenCode binds
  only after locator discovery (no `--session`, pending marker before,
  associated→changed→meta after); live fresh-agent ownership blocks a
  terminal resume for each runtime provider. Restart tests rebuild the
  ledger from its root; no live-PTY-survives-restart claim.
- Real OpenCode contract (gated on
  `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`, isolated home): a fabricated
  preallocated id fails with `Session not found`; a provider-owned session
  attaches via `--session`; record the detected version. The vitest
  command MUST pass the server vitest config or it selects nothing (I-36).
- **Amplifier contract (LB20, pinned):** validated against amplifier CLI
  `2026.07.13-51194ef` / core `1.6.0` — the real CLI adopts a
  broker-shaped pre-created stub under the cwd slug, preserves
  `metadata.json` (`session_id`, `freshell_terminal_id`), and leaves
  `turn_count` unset on zero-turn adoption. The second (API-key-gated)
  test was **skipped** in validation — never read that skip as coverage;
  run it opportunistically when a key is present. A future amplifier
  release changing adoption/rejection semantics stops the work and is
  reported as a provider contract change.
- Browser E2E: one Rust-only Playwright spec (fake provider fixtures,
  scratch server; never port 3002) covering the incident resume, fresh
  Claude/Amplifier/OpenCode shapes, and a spec-owned scratch restart with
  durable resume. Register the spec in **both** the rust-chromium
  `testMatch` allowlist and the `RUST_ONLY_SPECS` exclusion list, and
  verify the Playwright summary shows its tests ran (I-36).

---

### Slice J — Whole-branch verification, reviews, and handoff

Verify only; fix branch-caused failures with focused tests and focused
commits.

- [ ] **Focused regressions:** rerun each slice's headline suites
  (admission table, registry publication, both sink test modules, the
  cross-kind barrier suite, the merged integration suite, auto-resume e2e,
  directory projection, the client bootstrap/handler/selector tests).
- [ ] **Rust gates:** `cargo fmt --all --check`; workspace clippy with
  `-D warnings` (plus the real-transport feature builds for the
  codex/opencode crates); `cargo test --workspace --all-targets`.
- [ ] **Contract/JS gates (via the shared test coordinator):** port tests;
  `npm run contract:generate` with **no unexplained drift** — the expected
  protocol delta is exactly the collision frame added through the full
  contract per I-28 (committed regeneration diff + `SERVER_MESSAGE_TYPES`
  promotion + shape pins) plus any server-internal claim-variant additions;
  protocol crate tests `--locked`; status tests; coordinated `npm run
  check`; lint. If generation shows anything else, stop and report.
- [ ] **Browser acceptance:** the Slice I spec on rust-chromium.
- [ ] **Scope audit:** `git diff --stat/--name-only origin/main...HEAD` —
  require: no selector change; no Node server change; no OpenCode
  preallocation; no provider launch-policy drift beyond the documented
  LB15 legacy-restub change and D5 removal; no gemini/kimi behavior
  change; no production/evidence artifacts; no uncommitted changes; no
  port-3002 action.
- [ ] **Reviews:** broad code review over `origin/main...HEAD`; then Fresh
  Eyes on the complete delta, up to five rounds or until pass (see Review
  gates). If the fifth round fails, report loudly and do not claim
  readiness.
- [ ] **Report + stop (no push, no PR):** worktree/branch/base/head SHAs
  and the Preflight baseline evidence; focused commits per slice; the
  invariant-by-invariant evidence map (which tests prove I-1…I-36,
  including: the barrier suite with exact loser errors and attach-door
  coverage; the poisoned-key retry; the epoch/double-clear and
  hold-epoch regressions; the rebind transfers; the subprocess abort
  test; the client-abort and kill-during-settlement tests; the
  duplicate-id pre-reservation; the ownership-record replacement-safety;
  the amplifier claim-before-stub; the D5 rejection pair; the rejection
  ladder; the deferred re-auth dispositions; the enqueue-order and
  adverse-interleaving tests; the collision frame/banner tests; the
  boot/teardown wiring proofs); the `gf ui` green-pin evidence referencing
  #584's landed pins; binder-absorption evidence including any
  deliberately rescoped raw-id pin recorded as a delta; provider-matrix
  outcomes with the OpenCode version and the pinned amplifier contract
  version + key-gated skip status; verification command outcomes and
  review rounds; readiness for explicit PR approval. Report admission
  results with the honest invariant wording — never "two writers can never
  share a session."

---

## Validation Provenance

Every invariant above traces to a validated finding or review round. The
full finding-by-finding record (twenty load-bearing assumptions across
validator groups G1–G5; four Fresh Eyes rounds) lives in this file's git
history — revisions 1–4 at commits `f8e61145`, `0763a47a`, `35d4caac`,
`2248efe9` on this branch — and in
`attempts/rest-terminal-identity-publication-20260729/HANDOFF.md`. Compact
map:

| Source | Established |
| --- | --- |
| G1 (lifecycle validation: LB1, LB4–LB9) | I-13…I-16, I-20…I-23, I-25, I-27 |
| G2 (wiring/read models: LB2, LB11, LB17, LB18) | I-18, I-26, I-27, I-30 |
| G3 (authority/existence/providers: LB10, LB12, LB13, LB15, LB16, LB20) | Launch-hint/authority split, I-9…I-12, D1, Slice I amplifier pin |
| G4 (cross-runtime admission: LB14) | I-1…I-5, D2/D3/D4, the honest admission invariant |
| G5 (task-graph executability: LB19) | Slice order A…J, TDD discipline (runtime reds, compilable commits) |
| FE round 1 | I-15 (abort-on-panic), I-25 (PIN2 rescope), I-16 (settlement owner), I-32, discovered-claim never-adopt (I-4), binder absorption (Slice E2), #584 reconciliation |
| FE round 2 | I-5 (admission epochs), I-4 (conflict holds), I-3 (holder kinds), I-10 (atomic freshness, fresh-Unknown), I-20 (awaited close), I-21 (every-exit pending delete), I-36 (vacuous greens, config traps) |
| FE round 3 | D3 clarification + honest invariant, I-4 (prior tokens, hold epochs), I-7, I-8, I-9 (self-exemption), I-13, I-16 (Running re-check), I-24, I-12 (claim-before-stub), provenance-at-typed-seams |
| FE round 4 (no criticals; folded as invariants) | I-6 (R4-F1), I-24's admission-epoch-at-publication (R4-F2), I-17 incl. pane_ops (R4-F3), I-28 (R4-F4), I-29 (R4-F5), I-34 (R4-F6), I-35 (R4-F7/F8) |
| User decisions | D1–D5 + standing constraints (Approvals section) |

Do not resurrect any prior revision's lifecycle semantics, residual-race
language, extension-lane collision frame, or prescriptive mechanics from
the git history — history is evidence, not specification.
