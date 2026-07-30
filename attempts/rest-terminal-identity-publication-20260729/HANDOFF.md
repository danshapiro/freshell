# REST Terminal Session Identity Publication — Takeover Handoff

> **SUPERSEDED (2026-07-30).** This handoff is a historical record of the state
> at 2026-07-29. All five validation groups have since completed, PR #584
> merged the Claude-focused branch into `main`, and the unified plan was
> rewritten, renamed, and restructured. The current plan is
> `docs/superpowers/plans/2026-07-29-unified-terminal-identity-publication.md`
> on this branch; the plan path referenced throughout this document
> (`docs/superpowers/plans/2026-07-29-rest-terminal-session-identity.md`) now
> holds PR #584's own historical plan on `main` and is NOT the unified plan.
> Follow the current plan, not the sequencing instructions below.

**Status:** Paused at the user's request after evidence preservation, root-cause
investigation, unified planning, load-bearing assumption discovery, validation
strategy, and the first of five planned validation groups.

**Do not implement the current plan unchanged.** The first validation group
falsified six lifecycle assumptions, confirmed one lock-order assumption only
under a strict callback contract, and found one gate/error-path claim
inconclusive. The remaining twelve high/critical assumptions have not yet been
validated.

**No production code was changed in this worktree. No PR was created. Nothing
was pushed. Nothing was deployed. Port 3002 was not built, stopped, or
restarted.**

## 1. User intent and the requested workflow

The original incident was two left-hand-sidebar entries titled `gf ui` that
appeared to point to the same thing. The user asked, in order, to:

1. Preserve evidence before the entries were killed.
2. Root-cause what happened with an xhigh subagent.
3. Fix the root cause "with the usual."
4. Reconcile the proposed work with a separate Claude-identity plan and
   determine why that implementation should or should not be taken over.
5. Investigate whether OpenCode CLI and Amplifier need the same fix.
6. Implement the resulting unified solution, preferring xhigh subagents for
   planning.
7. Pause at a reasonable point.
8. Produce this comprehensive handoff in an attempt directory.

In this repository, "the usual" is defined by `AGENTS.md`:

1. Use the `writing-plans` skill.
2. Run `load-bearing` on the plan and fix every issue found.
3. Run Fresh Eyes on the plan, fixing findings, up to three rounds or until it
   passes.
4. Use `executing-plans` to implement the plan.
5. Run Fresh Eyes on the final delta up to five rounds or until it passes.
6. Halt only for a serious data-loss/confusion risk.
7. End with a low-jargon recap of findings at every stage.

Only steps 1 and the discovery/strategy/first-validator portion of step 2 have
been completed. The user explicitly asked to pause before any more validation
or implementation.

## 2. Canonical locations

### 2.1 Clean planning worktree

- Worktree:
  `/home/dan/code/freshell/.worktrees/rest-codex-terminal-identity`
- Branch: `fix/rest-terminal-identity-publication`
- Current commit before this handoff:
  `c04ba49cb088c5422dba5b8d0ec38461dc1be659`
- Commit subject: `docs: plan unified terminal identity publication`
- The unified plan:
  `docs/superpowers/plans/2026-07-29-rest-terminal-session-identity.md`
- This handoff:
  `attempts/rest-terminal-identity-publication-20260729/HANDOFF.md`

The worktree was clean immediately before this handoff was added.

### 2.2 Preserved incident evidence

- Evidence root:
  `/home/dan/.freshell/evidence/gf-ui-20260729T210120Z`
- Human-readable inventory:
  `/home/dan/.freshell/evidence/gf-ui-20260729T210120Z/MANIFEST.txt`
- Integrity manifest:
  `/home/dan/.freshell/evidence/gf-ui-20260729T210120Z/SHA256SUMS`
- Size: approximately 18 MiB.
- Files: 132 total; 131 evidence files are covered by `SHA256SUMS`.
- Verification repeated during handoff preparation:

  ```text
  verified_ok=131 failures=0
  ```

Do not mutate, normalize, move, or rewrite this evidence. Tests must use fake
provider homes and temporary directories, never this bundle or the user's live
provider state.

### 2.3 Separate Claude-focused worktree

A separate branch contains an earlier Claude-focused plan and partial
implementation:

- Worktree:
  `/home/dan/code/freshell/.worktrees/rest-terminal-session-identity`
- Branch: `fix/rest-terminal-session-identity`
- Current observed head:
  `4d46c86a fix(freshagent): REST claude creates mint a preallocated --session-id (WS parity, kata hbsa)`
- It was clean when inspected during handoff preparation.
- Commits above the original base, newest first:

  ```text
  4d46c86a fix(freshagent): REST claude creates mint a preallocated --session-id (WS parity, kata hbsa)
  180a15e9 refactor(platform): shared fresh-claude preallocation predicate for both create doors
  4709ee8a docs(plan): fix fresheyes blocking issues — respawn test body carries mode:claude (respawn is body-driven, empty body respawns shell); retire_pane_identity mirrors the natural-exit hook only (no retire_closed, Bound row survives natural exit)
  65cc1e76 docs(plan): fix fresheyes blocking issues — assert sessionRef on real surfaces (broadcast paneContent + registry rows, not REST HTTP bodies); spot-revert the mint gate, not launch_intent
  6d7e5a22 docs(plan): fix fresheyes blocking issues — sync binder trait, no async-trait dep, tracked superpowers plan premise
  04da6d94 docs(plan): apply load-bearing validation findings to REST session-identity plan
  3ac59747 docs: add implementation plan for rest-terminal-session-identity
  eb28b3dc docs: plan REST Codex terminal identity publication
  ```

Preserve this branch. It is not junk, and the user's question about taking over
the Claude implementation was valid. The shared fresh-Claude preallocation
work and its tests may be reusable. However, do not merge or cherry-pick the
branch wholesale until the unified plan is corrected: its design and review
history address a narrower provider/lifecycle surface, while the incident
itself was Codex and the same publication split also affects accepted OpenCode
and Amplifier identities.

The safe next-agent posture is:

1. Treat the Claude branch as a source of reviewed implementation and tests.
2. Compare each production commit with the corrected unified architecture.
3. Reuse or cherry-pick only commits whose invariants still hold.
4. Do not edit that worktree while another agent may own it.

### 2.4 Base-branch drift

The unified planning branch was created from:

```text
4c04dc9c Merge pull request #579 from danshapiro/fix/opencode-existence-fallback
```

At handoff time, both local `main` and `origin/main` had advanced to:

```text
ca1a60d3 Merge pull request #581 from danshapiro/fix/capture-coverage-gate
```

The unified branch therefore reported:

```text
[ahead 1, behind 25]
```

The intervening history is mostly the capture-coverage-gate and
deck-icons-polish work, but the next agent must inspect the actual diff rather
than assuming it is irrelevant. Repository rules require behavior work to be
based on current `origin/main`. Before implementation:

1. Fetch and inspect current `origin/main`.
2. Decide whether to rebase this branch or create a new worktree from current
   `origin/main` and cherry-pick the plan/handoff commits.
3. Run the repo-supported baseline on that exact intended base before creating
   any new worktree, as required by `AGENTS.md`.
4. Never rewrite or discard the separate Claude-focused branch.

The earlier baseline evidence is still useful but no longer proves the new
base:

```text
npm test
9,585 passed
27 skipped
0 failed
```

## 3. Preserved incident: exact facts

The evidence shows one real process and one real Freshell pane, not two
independent `gf ui` sessions.

### 3.1 Identifiers at capture time

| Object | Value |
| --- | --- |
| Freshell server instance | `srv-f06932e9-212f-4c14-87c0-21d379aba9fc` |
| Freshell server PID | `1564499` |
| Tab ID | `8126d789-7785-4dc1-82a1-b0045baed196` |
| Pane ID | `f2071dcb-2449-43f1-9011-a39440f72a26` |
| Terminal ID | `8f673dee-3160-45cd-91ec-e5411eb5523d` |
| Pane create request ID | `e6429f35462941f9ac74fc2d12b1517c` |
| Codex PID | `1574642` |
| Codex session ID | `019f9cb3-f11e-79f3-a968-287a5bc5798c` |
| CWD | `/home/dan/code/glowforge` |
| Title | `gf ui` |

### 3.2 The two sidebar keys

- Real history/session key:
  `codex:019f9cb3-f11e-79f3-a968-287a5bc5798c`
- Synthetic live-terminal fallback:
  `codex:terminal:8f673dee-3160-45cd-91ec-e5411eb5523d`

### 3.3 The contradiction that created the duplicate

1. `GET /api/tabs` returned one tab titled `gf ui`.
2. `GET /api/terminals` returned one live terminal titled `gf ui`.
3. The pane snapshot contained both the current terminal ID and the correct
   canonical Codex `sessionRef`.
4. The live terminal directory record had no `sessionRef`.
5. The Codex history record existed under the real session ID.
6. The pane ledger was stale: it still bound that session to terminal
   `981008395cbd4bfeb8aa762a3b83ddf4` and create request
   `M7GI-T6HHADkin0u7fA0D`, not the current terminal/create request.
7. Process evidence showed exactly one process launched as:

   ```text
   codex resume 019f9cb3-f11e-79f3-a968-287a5bc5798c
   ```

The selector was not inventing two processes. It received two conflicting read
models for the same pane:

- pane content with the real canonical session identity; and
- a live terminal row with no canonical identity, forcing a synthetic
  terminal-based key.

## 4. Root cause

The recovery/create operation went through the REST `POST /api/tabs` path.
That path:

1. accepted the correct Codex `sessionRef`;
2. launched the correct resumed Codex process;
3. completed the terminal registry's D8 ownership/binding logic;
4. wrote the canonical identity into pane content;
5. but skipped the shared `TerminalIdentityRegistry` and `PaneLedger`
   publication performed by the WebSocket terminal-create path.

`/api/terminals` intentionally did not infer a Codex identity solely from
resume argv. Therefore, its row stayed identityless even though the pane knew
the correct session. The client then represented the pane/history identity and
the unidentified live-terminal fallback separately.

The root cause is a split authoritative publication pipeline, not a rendering
or selector bug.

## 5. Why the scope became unified instead of Claude-only

The Claude-focused branch contains useful work, but a Claude-only fix does not
cover the incident or the whole architectural defect:

1. The observed duplicate was Codex, not Claude.
2. Explicit REST resumes with an accepted provider/session reference need the
   same publication guarantees for Claude, Codex, OpenCode, and Amplifier.
3. Fresh Claude and fresh Amplifier have server-known identities at launch and
   can publish through a known-identity create path.
4. Fresh OpenCode cannot use a Freshell-minted arbitrary ID; OpenCode 1.18.9
   treats `--session <id>` as an existing-session attach and reports
   `Session not found` for a made-up ID.
5. Fresh Codex and fresh OpenCode therefore need provider-discovery paths that
   converge on the same downstream publisher after the provider creates the
   identity.
6. Freshell already has a `PaneIdentitySink`/`LedgerIdentitySink` concept used
   by discovery paths. Generalizing that existing seam is architecturally
   preferable to installing another independent Claude-only binder.

This does **not** mean "throw away the Claude implementation." It means the
final design should absorb the sound pieces of that branch into one
provider-aware publication path.

## 6. Provider findings already established

### 6.1 Claude

- Fresh Claude already has a supported server-minted identity strategy:
  `--session-id <uuid>`.
- Explicit resume uses `--resume <id>`.
- The separate Claude branch implements/refactors part of this behavior and
  should be mined for reusable commits and tests.

### 6.2 Amplifier

- The REST launcher already mints a UUID for a fresh session.
- It computes an effective cwd.
- It creates a provider stub before invoking:

  ```text
  amplifier resume <uuid>
  ```

- Pane state and the provider directory can agree on that identity.
- The REST path still skips the authoritative terminal-identity registry and
  durable pane-ledger publication.
- A real installed-CLI stub-adoption contract remains an unvalidated
  load-bearing assumption; see LB20 below.

### 6.3 OpenCode

- Explicit REST resume has a known accepted session reference and launch
  identity, but still skips the authoritative identity registry and ledger.
- Fresh OpenCode must launch without a made-up `--session`.
- The existing locator discovers the provider-created ID and already performs
  a broad fan-out: identity registry, registry metadata, ledger binding,
  pending-marker deletion, and client metadata.
- That fan-out should converge through the shared publication abstraction, but
  its retired-signal behavior has a special missing-registry-row contract that
  the current unified plan gets wrong.

### 6.4 Codex

- Explicit REST resume has a known accepted session reference.
- Fresh Codex remains rollout/locator-discovered.
- The original incident proves the explicit REST path can launch correctly
  while failing to publish canonical terminal identity.

### 6.5 Gemini and Kimi

Current code treats these as session-capable terminal modes in legacy
promotion/inference paths. The unified plan's four-provider existence model
does not cover them. Removing heuristic inference without an explicit
Gemini/Kimi compatibility decision may create new identityless restores and
synthetic duplicates. This is LB16 and is not yet validated.

## 7. Current unified plan

The plan is:

```text
/home/dan/code/freshell/.worktrees/rest-codex-terminal-identity/
  docs/superpowers/plans/2026-07-29-rest-terminal-session-identity.md
```

It is 2,015 lines and currently proposes:

- explicit provenance values:
  - `AcceptedSessionRef`
  - `ServerPreallocated`
  - `ProviderDiscovered`
  - `ExistenceValidatedLegacyResume`
- a generalized `PaneIdentitySink`/`LedgerIdentitySink`;
- known-identity publication during create;
- discovery-time publication for fresh Codex/OpenCode;
- terminal-row plus in-memory identity publication under the registry
  critical section;
- durable/degraded persistence outcomes;
- ordered invalidation and metadata broadcasts;
- removal of non-Codex `/api/terminals` inference;
- generic legacy existence validation;
- migration of signal rebinds;
- generic exit retirement;
- eight implementation tasks with TDD checkpoints.

The plan commit was originally a narrower Codex-only commit
`6100ce4b`, then amended into the unified commit `c04ba49c`. The old object can
still appear in the reflog; the branch itself contains one plan commit above
its original base.

### 7.1 Important warning

The plan's goal and provider matrix remain useful. Its lifecycle and task
sequencing are **not execution-ready**. At minimum, the plan needs a major
revision incorporating sections 9–11 of this handoff, followed by the
remaining load-bearing validators and up to three Fresh Eyes plan reviews.

## 8. "The usual" workflow state

### 8.1 Skills/instructions already read by the coordinating agent

The coordinating agent read these instruction files completely:

- `/home/dan/.codex/skills/writing-plans/SKILL.md`
- `/home/dan/.codex/skills/load-bearing/SKILL.md`
- `/home/dan/.codex/skills/load-bearing/references/subagent-prompts.md`
- `/home/dan/.codex/skills/fresheyes/SKILL.md`
- `/home/dan/.codex/skills/executing-plans/SKILL.md`
- `/home/dan/.codex/skills/subagent-driven-development/SKILL.md`
- `/home/dan/.codex/skills/test-driven-development/SKILL.md`
- `/home/dan/.codex/skills/test-driven-development/testing-anti-patterns.md`
- `/home/dan/.codex/skills/using-git-worktrees/SKILL.md`
- `/home/dan/.codex/skills/requesting-code-review/SKILL.md`
- `/home/dan/.codex/skills/requesting-code-review/code-reviewer.md`
- `/home/dan/.codex/skills/verification-before-completion/SKILL.md`
- `/home/dan/.codex/skills/finishing-a-development-branch/SKILL.md`

A takeover agent must read applicable skills itself; this list is a workflow
record, not a substitute for that requirement.

### 8.2 Completed

- Evidence preservation and checksum verification.
- Incident root cause.
- Cross-provider investigation for Claude, Codex, OpenCode, and Amplifier.
- Clean isolated planning worktree.
- Unified xhigh-authored plan.
- Plan committed.
- Load-bearing finder phase.
- Load-bearing validation strategist phase.
- Load-bearing validator group G1.

### 8.3 Not started or not completed

- G2 validator: shared sink wiring, duplicate read models, transport ordering,
  and production test boundary.
- G3 validator: authority separation, cold existence, liveness ordering,
  Amplifier staging, Gemini/Kimi, and the real Amplifier contract.
- G4 validator: critical terminal-vs-fresh-agent shared admission.
- G5 validator: TDD task/commit feasibility.
- Plan revision after validators.
- Fresh Eyes review of the **unified** plan.
- Implementation.
- Per-task spec/code review.
- Fresh Eyes review of the implementation delta.
- Full verification on the eventual current base.
- Push or PR.
- Deploy.

Do not infer that Fresh Eyes already passed the unified plan. The separate
Claude-focused branch contains commits responding to earlier Fresh Eyes
reviews, and the user previously clarified that those review agents completed.
Those results do not review commit `c04ba49c`.

## 9. Load-bearing discovery: all 20 assumptions

The finder classified every item as high or critical. None should be silently
deferred.

### 9.1 G1 — ownership, locks, exit, retirement, epochs

These were validated. Detailed verdicts are in section 10.

- LB1: strong owner-probe/state/sink ownership cycle.
- LB3: registry-to-identity lock ordering and callback re-entry.
- LB4: exit-gate opening on duplicate/error/unwind paths.
- LB5: pre-spawn `Bound` ledger row visible as `ledgerOnly`.
- LB6: exit cleanup racing later durable/pending publication.
- LB7: blanket `Closed` retirement breaking auto-resume/restart semantics.
- LB8: terminal-ID-only async cleanup erasing a newer binding epoch.
- LB9: retired OpenCode signal rebind with no terminal registry row.

### 9.2 G2 — wiring, read models, transport, test boundary

These remain unvalidated:

- **LB2:** All consumers receive the same pointer-identical sink and every
  `OnceLock::set` succeeds. Current setters may silently discard set failures;
  plan assertions do not cover all consumers.
- **LB11:** Removing terminal-directory inference while leaving pane promotion
  of plausible raw resume IDs may recreate the exact real-key plus synthetic
  terminal-key duplicate.
- **LB17:** Enqueuing WebSocket invalidations before returning HTTP does not
  prove the browser observes those frames before the HTTP response.
- **LB18:** A `freshell-ws` integration test likely cannot import the
  production `LedgerIdentitySink`, which is private to binary-only
  `freshell-server`, without duplication, extraction, or a dependency cycle.

### 9.3 G3 — authority, existence, provider compatibility

These remain unvalidated:

- **LB10:** A rejected/non-authoritative raw legacy resume remains in
  `registry.resume_session_id` and may still drive activity, liveness, leases,
  inventory, or reconciliation.
- **LB12:** A one-shot existence probe can return `Unknown` during cold index
  refresh, leaving a genuine resumed session permanently identityless.
- **LB13:** Rejecting authority on `Unknown`/`Absent` before checking live
  fresh-agent ownership can miss an existing live owner and launch a second
  writer.
- **LB15:** Amplifier's current stub creation may happen before the planned
  existence decision, allowing Freshell's own stub to self-authorize a
  caller-provided ID.
- **LB16:** Gemini and Kimi are supported by current legacy restore inference
  but absent from the proposed four-provider existence model.
- **LB20:** The installed real Amplifier CLI must be shown to adopt the exact
  broker-shaped pre-created stub under the cwd slug.

### 9.4 G4 — critical cross-runtime admission

- **LB14 (critical):** Terminal D8 leases and
  `FreshAgentSessionLeases` are separate. A terminal create and a fresh-agent
  create for the same provider/session can simultaneously pass reciprocal
  liveness checks, acquire different leases, and spawn two writers.

The current plan explicitly describes this as a residual race. The user did
not approve accepting a data-corruption risk. Treat this as blocking until a
shared atomic provider/session admission mechanism is designed and proven for
Claude, Codex, and OpenCode.

### 9.5 G5 — plan executability

- **LB19:** Task 1 introduces compile-failing tests for symbols not created
  until later tasks, then asks later runtime tests and commits to proceed while
  those tests remain red. Rust compiles the whole selected target, so the
  described red/green/commit sequence is likely infeasible. One example
  classifier call also appears not to match the proposed return type.

The task graph must be reordered into compilable vertical slices before
execution.

## 10. Completed G1 validation report

The validator was an xhigh subagent and performed read-only inspection plus
focused existing tests. It changed no files and touched no services.

### 10.1 LB1 — strong `Arc` cycle

**Verdict:** Falsified. Confidence 0.99.

The plan makes the sink own a `FreshAgentOwnerProbe`. That probe closure
captures clones of the fresh-agent states. Those states contain strong
`Arc<OnceLock<Arc<dyn PaneIdentitySink>>>` fields that point back to the sink.
The graph is:

```text
sink
  -> owner-probe closure
  -> fresh-agent state
  -> OnceLock
  -> sink
```

Relevant locations:

- Plan lines approximately 895–1025.
- `crates/freshell-freshagent/src/lib.rs:122-123,209-213`
- `crates/freshell-freshagent/src/claude.rs:74-75,100-105`
- `crates/freshell-freshagent/src/codex.rs:98-99,149-154`
- `crates/freshell-freshagent/src/opencode_ws.rs:90-113`

Required correction:

- Capture weak runtime projections in the probe, or retain the sink weakly in
  the states.
- Add a drop/strong-count test proving all boot states, sink, and owned child
  resources are released when external server handles are dropped.

### 10.2 LB3 — registry to identity lock order

**Verdict:** Confirmed under explicit constraints. Confidence 0.92.

The proposed atomic memory transition takes `RegistryInner` and then performs
an identity-registry write. Existing identity operations take their own
`RwLock`, return owned clones, and do not retain the lock while probing the
terminal registry. The apparent reverse lookup currently drops the identity
guard before entering registry code.

Relevant locations:

- Plan lines approximately 585–602 and global constraints 101–102.
- `crates/freshell-ws/src/identity.rs:65-85,95-117,124-131,198-202`
- `crates/freshell-terminal/src/registry.rs:2294-2303`

The confirmation depends on a strict, permanent contract:

- `upsert_with_retirement` remains a leaf write-lock operation.
- The synchronous publication callback does no broadcast, ledger I/O, runtime
  probing, await, or terminal-registry re-entry.
- No identity-registry method calls terminal-registry code while retaining an
  identity guard.

Document this lock-order contract and test the actual final adapter. A future
"convenient" callback expansion could reintroduce deadlock.

### 10.3 LB4 — exit gate on error/unwind paths

**Verdict:** Inconclusive; the plan has not established safety. Confidence
0.96 that additional design/tests are required.

`PtyTerminal::Drop` kills the PTY and synchronously joins waiter and reader.
The reader invokes the exit hook. If that hook is blocked on a closed create
gate while the thread dropping the PTY waits in `join`, cleanup deadlocks.

Relevant locations:

- `crates/freshell-terminal/src/pty.rs:440-452,507-515`
- Current registry insertion:
  `crates/freshell-terminal/src/registry.rs:979-986`
- Plan lines approximately 486–512 and 553–563.

Current insertion also ignores a replaced `HashMap` value. A duplicate
terminal ID can therefore drop an old `PtyTerminal` while `RegistryInner` is
held.

Required correction/tests:

1. Create the open-on-drop guard immediately after successful PTY creation.
2. Declare/order ownership so the guard opens before a PTY can be dropped and
   joined.
3. Reject duplicate terminal IDs without replacing or dropping a PTY while
   holding `RegistryInner`.
4. Add barrier-bounded duplicate-error and `catch_unwind` publisher-panic
   tests that prove the gate opens before every possible PTY join.
5. Retain the immediate-natural-exit success-path test, but do not treat it as
   sufficient.

Existing tests run and passed:

```text
cargo test -p freshell-terminal \
  registry::tests::kill_all_never_group_signals_a_terminal_that_already_exited_naturally \
  -- --exact --nocapture
# 1 passed

cargo test -p freshell-terminal \
  registry::tests::activity_observer_sees_exit_on_natural_pty_exit \
  -- --exact --nocapture
# 1 passed
```

These tests cover existing behavior, not the proposed gate's new failure
paths.

### 10.4 LB5 — pre-spawn `Bound` row visibility

**Verdict:** Falsified. Confidence 1.00.

The plan awaits a pre-spawn `record_binding`, which immediately writes
`RowState::Bound`. Recovery inventory intentionally exposes any unreferenced
Bound row with no live registry owner as `ledgerOnly`. Between that write and
terminal insertion, the freshly minted identity can appear as a recovery
offer, potentially enabling competing recovery.

Relevant locations:

- Plan lines approximately 1193–1201.
- `crates/freshell-ws/src/pane_ledger.rs:357-418`
- `crates/freshell-server/src/recovery_inventory.rs:254-265`
- Assertion:
  `crates/freshell-server/src/recovery_inventory_tests.rs:226-231`

Existing test run and passed:

```text
cargo test -p freshell-server \
  recovery_inventory::tests::unreferenced_bound_rows_become_ledger_only \
  -- --exact --nocapture
# 1 passed
```

Required correction:

- Do not expose a pre-spawn server-minted identity as ordinary `Bound`.
- Use a durable prepared/pending state excluded from recovery inventory, or
  another transactional representation.
- Promote it to `Bound` only after terminal publication/finalization.
- Prove inventory cannot offer it while create is in progress.
- Preserve guarded cleanup using the exact terminal ID and create-request
  epoch.

### 10.5 LB6 — exit races later publication

**Verdict:** Falsified. Confidence 1.00.

The plan opens the exit gate immediately after in-memory identity publication,
then performs provider settlement, durable binding/pending writes, and
announcements. The PTY reader's exit hook runs concurrently. If exit cleanup
wins:

- later `record_binding` can resurrect a row as `Bound` after cleanup marked
  it retired; or
- fresh Codex/OpenCode cleanup can delete a pending marker before the create
  continuation writes it, leaving a new orphan marker after exit; or
- clients can receive association metadata for a terminal already retired.

Relevant locations:

- Plan lines approximately 181–193, 205–211, and 1243–1276.
- `crates/freshell-ws/src/pane_ledger.rs:398-418`
- `crates/freshell-terminal/src/registry.rs:1500-1524`

Required correction:

- Keep lifecycle finalization closed through provider settlement, durable
  binding/pending publication, and the create announcement; one option is a
  caller-held finalization guard returned by `create_with_publication`.
- Alternatively, make every late mutation generation-checked with a
  running-row CAS. This is more distributed and easier to get wrong.
- Add deterministic barriers around immediate exit versus every async
  post-spawn operation.

### 10.6 LB7 — blanket close retirement

**Verdict:** Falsified. Confidence 1.00.

The plan retires the durable row as `Closed` on every PTY exit. Current
auto-resume semantics intentionally require the old durable row to remain
`Bound`; an absent/closed owner means `pane_closed`. Natural crash and graceful
server shutdown are not the same as explicit user close.

Relevant locations:

- Plan lines approximately 205–211 and 982–989.
- `crates/freshell-ws/src/auto_resume.rs:407-427,445-460`
- Current natural-exit handling:
  `crates/freshell-ws/src/terminal.rs:1325-1405`
- Current explicit-close retirement:
  `crates/freshell-ws/src/terminal.rs:3847-3870`
- Registry kill/removal:
  `crates/freshell-terminal/src/registry.rs:1381-1406`

Existing test run and passed:

```text
cargo test -p freshell-ws --test auto_resume_e2e -- --nocapture
# 2 passed
```

Required correction:

- Model exit intent/cause.
- Retire `Closed` only for explicit user close.
- Preserve `Bound` through natural crash and auto-resume settlement.
- Preserve restart bindings during graceful shutdown.
- Test explicit close, natural crash, successful auto-resume, exhausted
  auto-resume, and graceful shutdown separately.

The earlier Claude-focused plan appears to have already corrected its own
blanket-retirement wording in commit `4709ee8a`; inspect that work rather than
rediscovering it.

### 10.7 LB8 — stale async cleanup can erase a new epoch

**Verdict:** Falsified. Confidence 0.99.

The proposed retirement interface accepts only `terminal_id`. Current
`PaneLedger::retire_closed` checks provider/session and Bound state, not the
terminal ID/create-request epoch. A delayed old cleanup can therefore retire a
replacement terminal's newly written row. Pending deletion is also keyed too
weakly for the proposed concurrency.

Relevant locations:

- Plan line approximately 819 and lines 982–989.
- `crates/freshell-ws/src/pane_ledger.rs:131-141,563-586,785-807`

Required correction:

- Introduce an ownership-conditional operation such as
  `retire_closed_if_owned(provider, session_id, terminal_id,
  create_request_id)`.
- Give pending markers an epoch and delete them conditionally.
- Perform the comparison and mutation under the ledger's serialization guard.
- Add a barrier test: pause old cleanup, bind a replacement, release old
  cleanup, and prove the replacement remains Bound/live.

### 10.8 LB9 — retired OpenCode signal with absent registry row

**Verdict:** Falsified. Confidence 1.00.

The plan's retired publisher requires an existing non-running terminal row,
but explicit `registry.kill` removes that row. Existing accepted behavior
allows a retained OpenCode signal to rebind after kill using the retained
identity entry, deliberately skipping `registry.set_meta` when the terminal row
is absent.

Relevant locations:

- Plan lines approximately 604–610, 1468–1473, and 1517–1521.
- `crates/freshell-terminal/src/registry.rs:1381-1406,3181-3200`
- `crates/freshell-ws/tests/opencode_switch_rebind.rs:730-785`
- `crates/freshell-ws/src/opencode_signal.rs:493-525`

Existing tests run and passed:

```text
cargo test -p freshell-terminal \
  registry::tests::kill_removes_terminal_notifies_subscribers_and_bumps_revision \
  -- --exact --nocapture
# 1 passed

cargo test -p freshell-ws --test opencode_switch_rebind \
  tui_switch_signal_rebinds_and_restart_resumes_the_new_id \
  -- --exact --nocapture
# 1 passed
```

Required correction:

- Keep a separate trusted retired-signal publication lane.
- Permit an absent terminal row only when the retained retired identity and
  exact previous-session/CAS conditions match.
- Update identity registry and ledger without fabricating a live registry row.
- Preserve the established kill/removal contract.

## 11. Recommended architecture changes before implementation

These are not yet a final plan; they are the minimum direction implied by
current evidence.

1. **One shared publication service, but separate transition types.**
   Known-at-create, discovered-while-running, and trusted-retired-signal
   publication do not share identical row preconditions. Put them behind one
   policy/service boundary without pretending they are one state transition.

2. **Weak ownership across runtime probes.**
   Avoid the sink-to-state-to-sink `Arc` cycle. Make teardown observable in a
   test.

3. **One cross-runtime provider/session admission coordinator.**
   Terminal creates and fresh-agent creates must acquire the same lease before
   reciprocal liveness checks and spawning. Do not accept LB14 as residual.

4. **Separate launch hints from authoritative identity.**
   A compatibility `resume_session_id` used to form argv must not silently
   remain authoritative registry/activity metadata after existence
   authorization rejects it.

5. **Liveness protection must not depend on a warm disk index.**
   Check shared live ownership even when existence is `Unknown` or `Absent`.
   Design eventual authorization for legitimate cold-index restores.

6. **Use an explicit durable prepared state if pre-spawn durability is
   required.**
   It must be excluded from recovery offers and promoted only by the matching
   create epoch.

7. **Keep create finalization closed through async settlement.**
   The PTY exit hook must not overtake ledger/pending writes and announcement.
   All error/unwind paths must open the gate before PTY join.

8. **Distinguish explicit close from natural exit and graceful shutdown.**
   Only explicit user close should make the durable row `Closed`.

9. **Make every delayed mutation epoch-conditional.**
   Capture provider, session ID, terminal ID, and create request ID. Never let
   old cleanup erase a replacement owner.

10. **Preserve the missing-row retired OpenCode lane.**
    It needs exact retained-identity authorization, not a fabricated live row.

11. **Fix both conflicting read models.**
    Validate LB11 before removing directory inference. Pane promotion of a raw
    unvalidated ID and terminal synthetic fallback can reproduce the original
    duplicate even if the terminal inference is removed.

12. **State transport ordering honestly.**
    A server can guarantee WebSocket frames were enqueued before HTTP handler
    completion, not that the browser observed them first, unless an
    acknowledgment/barrier protocol is added.

13. **Put production adapter tests at a valid crate boundary.**
    Validate LB18. Likely options are a server-side test, extracting the
    adapter into an importable lower crate, or testing a public composition
    root. Do not copy a fake sink into `freshell-ws` and call it production
    coverage.

14. **Reorder the plan into compilable vertical TDD slices.**
    Each task must introduce its test surface and minimum implementation
    together, reach green, refactor, and commit before the next task.

15. **Preserve Gemini/Kimi behavior deliberately.**
    Either add an authoritative strategy, retain a narrowly documented
    compatibility path, or explicitly obtain product approval to deprecate
    those restores.

16. **Run the real Amplifier adoption contract in isolation.**
    Do not touch the user's live Amplifier state.

## 12. Remaining validation assignments

The previous strategist produced these groups. Use xhigh planning/validation
agents, matching the user's preference. Run G2 and G3 in parallel if slots
allow, then G4 and G5. Validators must be read-only.

### 12.1 G2 prompt scope

Validate LB2, LB11, LB17, and LB18:

- inspect every sink setter and production construction site;
- prove pointer equality or identify missing getters/assertions;
- inspect raw pane promotion plus terminal-directory fallback and run focused
  selector tests;
- distinguish WebSocket enqueue ordering from browser observation ordering;
- inspect Cargo metadata and the binary-only server test boundary.

Useful first commands:

```bash
sed -n '180,205p' crates/freshell-freshagent/src/claude.rs
sed -n '310,330p' crates/freshell-freshagent/src/codex.rs
sed -n '228,245p' crates/freshell-freshagent/src/opencode_ws.rs
sed -n '286,305p' crates/freshell-freshagent/src/lib.rs
rg -n 'promoted_legacy_claim|resumeSessionId|liveTerminalSessionId|collectSessionRefsFromTabs' \
  crates/freshell-ws/src/reconcile.rs \
  src/store/selectors/sidebarSelectors.ts \
  src/lib/session-utils.ts
cargo metadata --no-deps --format-version 1
```

Required output per assumption:

- verdict: confirmed, falsified, or inconclusive;
- exact evidence;
- confidence;
- new assumptions introduced;
- whether user approval is needed.

### 12.2 G3 prompt scope

Validate LB10, LB12, LB13, LB15, LB16, and LB20:

- enumerate every registry `resume_session_id` consumer;
- test cold-index/requery behavior;
- prove live-owner checks cannot be skipped by existence status;
- trace Amplifier existence versus stub ordering;
- inventory Gemini/Kimi restore behavior;
- run the installed real Amplifier adoption contract in its existing isolated
  harness.

Useful commands:

```bash
cargo test -p freshell-terminal \
  registry::tests::live_session_owner_finds_running_row_by_resume_session_id \
  -- --exact --nocapture

cargo test -p freshell-server \
  existence::tests::session_written_after_cold_read_resolves_present_on_requery \
  -- --exact --nocapture

cargo test -p freshell-ws --test amplifier_launcher_identity \
  requested_amplifier_resume_with_missing_dir_is_restubbed_under_same_id \
  -- --exact --nocapture

FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- \
  run test/integration/real/amplifier-stub-adoption-contract.test.ts \
  --config config/vitest/vitest.server.config.ts \
  -t 'adopts a broker-shaped pre-created stub under the cwd slug'
```

The real-provider test already isolates provider state. Do not point it at the
user's home or alter live Amplifier data.

### 12.3 G4 prompt scope

Validate LB14 as a standalone critical item:

1. Prove whether terminal D8 and `FreshAgentSessionLeases` share one admission
   lock.
2. If separate, write the exact check/claim/spawn interleaving.
3. Design one shared cross-kind lease usable by terminal and fresh-agent
   creates.
4. Require barrier-synchronized simultaneous terminal/fresh-agent tests for
   Claude, Codex, and OpenCode.
5. Treat any remaining two-writer window as blocking, not an accepted
   residual.

Starting search:

```bash
rg -n 'FreshAgentSessionLeases|session_ref_leases|set_session_leases|claim_session_ref|claim\\(|has_live_session' \
  crates/freshell-terminal/src/registry.rs \
  crates/freshell-freshagent/src \
  crates/freshell-server/src/main.rs
```

### 12.4 G5 prompt scope

Validate LB19:

- map each proposed test to its Cargo target;
- identify symbols needed for compilation;
- simulate or reason through every red/green/commit boundary;
- rewrite the task dependency graph as compilable vertical slices;
- ensure no task commits known-red tests and no later focused command is
  blocked by an earlier compile failure.

Starting commands:

```bash
cargo metadata --no-deps --format-version 1
sed -n '279,1356p' \
  docs/superpowers/plans/2026-07-29-rest-terminal-session-identity.md
```

## 13. Next-agent sequence

Resume in this order:

1. Read repo `AGENTS.md`, the requested skills, this handoff, and the current
   unified plan.
2. Inspect current `origin/main` and choose a compliant current-base
   worktree/branch strategy. Do not silently rewrite either existing branch.
3. Run/finish G2 and G3 with xhigh validators.
4. Run/finish G4 and G5 with xhigh validators.
5. If any validator is inconclusive, use the strategist's fallback method
   rather than treating uncertainty as confirmation.
6. Give the full validator packet to an xhigh planning agent.
7. Rewrite the unified plan in place, incorporating all findings and a
   compilable TDD task graph.
8. Commit the corrected plan.
9. Run Fresh Eyes on the corrected unified plan, up to three rounds:

   ```bash
   /home/dan/.codex/skills/fresheyes/fresheyes.sh --claude \
     "Review the plan in docs/superpowers/plans/2026-07-29-rest-terminal-session-identity.md."
   ```

   Follow the skill's PID/progress/result workflow. Do not read its private log
   directly and do not kill the reviewer. If Claude errors, use the skill's
   GPT fallback.

10. Fix and commit each material plan-review finding before the next round.
11. Only after the plan is validated and Fresh Eyes passes (or three rounds
    are exhausted with loud disclosure), execute it using
    `executing-plans` plus sequential subagent-driven development.
12. Use red/green/refactor TDD for each vertical slice.
13. Run a spec review and code-quality review for each task before moving on.
14. Use the shared test coordinator for broad test runs.
15. Run Fresh Eyes on the final worktree-vs-original-base delta up to five
    rounds.
16. Run final verification, then commit all scoped work.
17. Stop before PR creation and ask the user for explicit approval.
18. Never deploy or restart the live Rust server on port 3002 without the exact
    user approval required by `AGENTS.md`.

## 14. Suggested implementation review strategy

When execution eventually starts:

- Use sequential implementation agents because tasks share Rust types and
  compile surfaces.
- Prefer xhigh for architecture-heavy tasks; the user specifically requested
  xhigh for planning.
- Do not let implementation agents edit the plan's architectural invariants
  opportunistically. Route discoveries back through the coordinator.
- Before each task, extract a bounded brief with:
  - exact files;
  - the behavior contract;
  - the red test and expected failure;
  - the green command;
  - invariants from load-bearing validation;
  - explicit exclusions.
- After each task:
  1. inspect the diff;
  2. run the focused test;
  3. run the task's broader package/integration tests;
  4. perform spec review;
  5. perform code-quality review;
  6. fix critical/important findings;
  7. commit atomically.

Maintain a tracked progress ledger if the selected
`subagent-driven-development` instructions require it.

## 15. Safety and scope boundaries

- Do not touch the live self-hosted Rust server on port 3002.
- Do not run `scripts/launch-rust.sh --restart` or `--stop` without explicit
  `APPROVED` from the user.
- Do not use broad process-kill commands.
- Do not mutate the evidence bundle.
- Do not use the user's real provider homes in tests.
- Do not discard, stash, reset, or rewrite another agent's changes.
- Do not modify the Claude-focused worktree merely to make this branch clean.
- Do not patch the client selector as a shortcut. The current evidence points
  to conflicting server read models.
- Do not infer authority from argv, title, cwd, raw pane payload, or mode plus
  raw resume ID.
- Do not remove Gemini/Kimi compatibility accidentally.
- Do not accept the cross-runtime two-writer race without explicit product
  approval; it is a potential session-corruption/data-loss problem.
- Do not create a PR until the user explicitly approves PR creation.

## 16. Commands and results already run

### 16.1 Evidence

```bash
sha256sum -c \
  /home/dan/.freshell/evidence/gf-ui-20260729T210120Z/SHA256SUMS
```

Summarized result:

```text
verified_ok=131 failures=0
```

### 16.2 Baseline on the original base

```text
npm test
9,585 passed
27 skipped
0 failed
```

This was run on `4c04dc9c`, not current `origin/main`.

### 16.3 G1 focused tests

```text
cargo test -p freshell-terminal \
  registry::tests::kill_all_never_group_signals_a_terminal_that_already_exited_naturally \
  -- --exact --nocapture
PASS: 1

cargo test -p freshell-terminal \
  registry::tests::activity_observer_sees_exit_on_natural_pty_exit \
  -- --exact --nocapture
PASS: 1

cargo test -p freshell-server \
  recovery_inventory::tests::unreferenced_bound_rows_become_ledger_only \
  -- --exact --nocapture
PASS: 1

cargo test -p freshell-ws --test auto_resume_e2e -- --nocapture
PASS: 2

cargo test -p freshell-terminal \
  registry::tests::kill_removes_terminal_notifies_subscribers_and_bumps_revision \
  -- --exact --nocapture
PASS: 1

cargo test -p freshell-ws --test opencode_switch_rebind \
  tui_switch_signal_rebinds_and_restart_resumes_the_new_id \
  -- --exact --nocapture
PASS: 1
```

These are evidence about current behavior; they do not validate the proposed
new implementation.

### 16.4 Earlier provider-focused tests reported during investigation

The following focused contracts were reported passing before unified planning:

- fresh Amplifier identity mint/pre-stub behavior;
- fresh OpenCode locator arming;
- explicit OpenCode resume identity synthesis;
- OpenCode association bind/broadcast;
- OpenCode and Codex restore-created identity resolution into the ledger.

Re-run the exact relevant tests after rebasing and when implementing. Do not
represent these earlier passes as final verification.

## 17. Agent-work record

Completed planning/validation agents:

- `identity_lb_finder`: enumerated the 20 high/critical assumptions.
- `identity_lb_strategist`: grouped them into G1–G5 and selected the cheapest
  reliable validation method for each.
- `unified_identity_plan`: produced the current unified plan with xhigh
  reasoning.
- `identity_lb_g1_lifecycle`: validated LB1 and LB3–LB9 with source evidence
  and focused tests.

No validator for G2, G3, G4, or G5 was started before the user requested a
pause. No implementation agent was started in this clean worktree.

## 18. Bottom line

The incident is understood: one correctly resumed Codex process was presented
twice because REST create published canonical identity to pane state but not to
the terminal identity registry or durable pane ledger.

The fix should be unified across provider paths while respecting provider
identity timing:

- known at launch for accepted resumes, fresh Claude, and fresh Amplifier;
- discovered later for fresh Codex and fresh OpenCode.

The existing Claude implementation should be harvested thoughtfully, not
ignored. The current unified plan is the right level of scope but is not safe
to execute yet. Its strongest defects are:

1. a strong `Arc` lifecycle leak;
2. a pre-spawn recovery-offer window;
3. an immediate-exit race that can resurrect or orphan persistence;
4. blanket exit retirement that breaks auto-resume/restart semantics;
5. cleanup operations without binding epochs;
6. a regression in supported retired OpenCode rebinds;
7. an unresolved critical cross-runtime double-writer race;
8. a likely non-executable TDD task sequence.

The correct resumption point is the remaining load-bearing validation, followed
by an xhigh rewrite of the plan—not production implementation.
