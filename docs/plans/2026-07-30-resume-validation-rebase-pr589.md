# Resume-Validation Rebase onto Main @ 2641ada38 (#589 Reconciliation) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Rebase the already-built, twice-reviewed branch `feat/resume-validation`
(27 commits atop `39010cb57`) onto current main (`2641ada38`, which merged PR #589
"graceful-restore-resume-s1"), resolving the one semantic conflict by carrying
`resume_id_from_wire` through main's new `LaunchPrep` struct (locked Option A),
restoring the gate-before-plan invariant against #589's off-permit codex planning,
and leaving the branch fully verified — no merge, no PR, no push, no deploy.

**Architecture:** This is a REBASE-RECONCILIATION pass, not a new feature. PR #589
extracted `derive_launch_prep()` from `handle_create` (producing a `LaunchPrep`
struct: `launch_intent` / `resume_session_id` / `claude_fresh_prealloc`) and moved
codex restore-class launch planning BEFORE the spawn-gate permit. The branch's gate
commit `1ed94741d` computes those same values inline plus a boolean
`resume_id_from_wire` — hence one conflicted file (`crates/freshell-ws/src/terminal.rs`,
one hunk). The work is: (1) replay the 27 branch commits, resolving the conflict by
extending `LaunchPrep`/`derive_launch_prep` with a 4th field `resume_id_from_wire`
(set in exactly one place — the wire-derivation `else` arm), (2) first-ever direct
unit tests on `derive_launch_prep` pinning the new field's origin semantics,
(3) a gate-level pin that server-allocated (prealloc'd) ids are NEVER gated,
(4) a reconciliation commit that runs the codex-mode wire-resume gate OFF-permit
inside `prepare_launch`, BEFORE `plan_codex_managed_launch` — final ordering for
codex restore-class creates: **gate → plan (off-permit) → permit → spawn** —
(5) docs-ledger truth-up, (6) full verification.

**Tech Stack:** Rust workspace (tokio, axum; CI: `cargo fmt --all --check`,
`cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`).
React/TypeScript client exists but #589 is Rust-only — client files should be
untouched by this rebase.

## Global Constraints

- Work ONLY in the existing worktree `/home/dan/code/freshell/.worktrees/resume-validation` on branch `feat/resume-validation`. Do NOT create a new worktree. (A safety backup **branch ref** is allowed and required in Task 1.)
- Rebase target is pinned to commit `2641ada382472586ce1aa7664331d384853e867d`. If `origin/main` has moved past it, still rebase onto the pinned hash and note the discrepancy in the final report — the resolution direction was locked against this exact main.
- Do NOT push, do NOT open a PR, do NOT merge — the orchestrator lands the branch afterward.
- Do NOT touch the live Rust server on port 3002 (never restart/stop it; `cargo build`/`cargo test` are safe and never touch it). Never use broad kill patterns (`pkill -f …`).
- Commit author must be `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>` (repo/global git config already provides this — never override it, never use `dan@danshapiro.com` as a git identity). Conventional Commits with scope (`fix(ws):`, `test(ws):`, `docs:`).
- Broad JS/Vitest runs go through the shared coordinator gate (`npm run check` / `npm run test:unit` with `FRESHELL_TEST_SUMMARY="<why>"` set; check `npm run test:status` first; never kill a foreign gate holder; never raw `npx vitest` for broad runs). Expected to be UNNEEDED here: the rebase must not touch client files (Task 7 verifies and gates this).
- `cargo test --workspace` is LONG — always run with a generous timeout (≥ 1800 s), never a 30 s default.
- Host-gated `#[ignore]` e2e tests mutate process env — run them alone: `-- --ignored --test-threads=1`.
- Known pre-existing unrelated failure on main: `test/e2e/terminal-font-settings.test.tsx` — if it ever shows up in a JS run, note it and move on; do not chase. (It is not run by `npm run test:unit`.)
- Respect other agents' concurrent activity: Task 1 verifies the worktree is clean and no rebase is in progress before starting; if it is dirty or mid-rebase, HALT and report instead of clobbering.
- Locked resolution direction (Option A): `resume_id_from_wire` is derived in `derive_launch_prep` as a `LaunchPrep` field. Do NOT re-compute it after extraction (divergence risk); do NOT infer it from surrounding context (fragile).

## Invariants (verified by tests in Tasks 2–7)

- **Branch:** gate-before-plan (a definitively-absent stale id is gated — fresh spawn + notice + `retire_missing` — without invoking codex managed-launch planning or consuming a sidecar planning slot); fail-open (Unknown/ProviderUnavailable → attempt resume); live sessions never gated (in-gate liveness join); the ~1 s codex by-id walk stays OFF hot reconnect paths (`exists_for_gate` is called only from spawn-door gate callers).
- **Main/#589:** off-permit codex planning for restore creates and its restore-storm pins (zero error frames, off-permit fairness, prepared-sidecar discard) keep passing. Final ordering for codex restore-class creates: **gate → plan (off-permit) → permit → spawn** (Task 5). For non-codex modes there is no off-permit plan step, so the gate stays at its branch position inside `handle_create` (post-ladder, post-D7, pre-`ensure_session` re-stub) — documented in code in Task 5.
- **Unchanged:** S5 managed-launch semantics, #582 breaker bookkeeping (pinned inside `auto_resume_respawn.rs::respawn_with_absent_session_spawns_fresh_and_retires_binding:520-556`), #584 identity threading. The replay must not regress them; Task 7's sweep proves it.

## Key facts (established by read-only investigation; line numbers are for `origin/main:crates/freshell-ws/src/terminal.rs` unless noted)

- `LaunchPrep` struct: `:1464-1468`. `derive_launch_prep(create: &TerminalCreate, mode: &str) -> LaunchPrep`: `:1474-1544`, `pub(crate)`, sync, pure, NO existing direct unit tests anywhere. Exactly two call sites, both in `terminal.rs`: `prepare_launch:1616` and the `handle_create` inline fallback `:1876`. The freshagent REST door (`crates/freshell-freshagent/src/terminal_tabs.rs:809`) has its OWN prep and does NOT use `derive_launch_prep` — the new field does not flow there (door 3 keeps its existing branch-side gate, which auto-merges).
- `git merge-tree --write-tree origin/main HEAD` reports exactly ONE conflicted file: `crates/freshell-ws/src/terminal.rs` (one hunk: main's `LaunchPrep` destructure + hoisted claude P0.4 ladder vs the branch's inline derivation). `crates/freshell-freshagent/src/terminal_tabs.rs` auto-merges.
- Branch commits touching `terminal.rs` (replay order): `5580abb62` → `1ed94741d` (THE conflict) → `ee2b7167c` → `e13a6b787`.
- Main binds `launch_intent`/`claude_fresh_prealloc` immutably in the `handle_create` destructure (`:1870-1877`); the branch's gate mutates both — the resolution MUST add `mut`.
- `resume_id_from_wire` semantics (branch `HEAD:terminal.rs:1637,1692,1811`): `true` iff the wire-derivation `else` arm ran — i.e. `mode != "shell"` AND neither `should_preallocate_fresh_claude` nor `should_preallocate_fresh_amplifier`. TRAP: `claude_fresh_prealloc` alone is NOT a "server-allocated" signal — the amplifier prealloc arm mints a server id with `claude_fresh_prealloc == false`. The field must be `false` for BOTH prealloc arms.
- The claude P0.4 restore ladder runs only when the `else` arm ran (claude prealloc requires `restore != Some(true)`, the ladder requires `restore == Some(true)`), so ladder-resolved ids are always `resume_id_from_wire == true` — the flag's value is unaffected by main hoisting the ladder out of the derivation.
- Main ordering (`origin/main:crates/freshell-ws/src/create_gate.rs`): `prepare_launch` (derive + codex `LaunchClass::Restore` plan) `:80` → permit `acquire_unbounded` `:129` → `handle_create(create, Some(prepared), …)` (7 args) `:224`. The branch's gate tests to reconcile against: `crates/freshell-ws/tests/resume_validation_gate.rs` (incl. `#[ignore]`d `managed_default_stale_codex_id_is_gated_before_planning:751`), `auto_resume_respawn.rs`, `rest_resume_*` unit tests in `terminal_tabs.rs`; main's pins: `crates/freshell-ws/tests/restore_storm.rs` (5 tests) and `restore_plan_queue_cap.rs` (1 test).

---

### Task 1: Preflight, safety snapshot, and rebase-target verification

**Files:**
- No repo files modified. Creates git ref `backup/resume-validation-pre-589-rebase`.

**Interfaces:**
- Consumes: nothing.
- Produces: a verified-clean worktree on `feat/resume-validation`, a backup ref, and recorded baseline facts (`N_COMMITS=27`, pre-rebase HEAD sha, pre-rebase client-file list) that Tasks 2 and 7 compare against.

- [ ] **Step 1: Verify worktree state and branch**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
git status --porcelain            # expect: EMPTY output (clean tree)
git branch --show-current         # expect: feat/resume-validation
ls .git 2>/dev/null; git rev-parse --git-dir   # informational
test -d "$(git rev-parse --git-path rebase-merge)" -o -d "$(git rev-parse --git-path rebase-apply)" \
  && echo "REBASE IN PROGRESS — HALT" || echo "no rebase in progress"
```

Expected: clean tree, correct branch, "no rebase in progress". **If the tree is
dirty or a rebase is in progress, HALT the task and report — another agent may be
mid-operation; do not clobber.**

- [ ] **Step 2: Fetch and verify the pinned rebase target**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
git fetch origin
git rev-parse origin/main
git cat-file -t 2641ada382472586ce1aa7664331d384853e867d   # expect: commit
git merge-base HEAD origin/main                            # expect: 39010cb5709481a807377241c162d192737df965
```

Expected: `2641ada38…` exists. If `origin/main != 2641ada38`, proceed anyway —
all later steps rebase onto the PINNED hash — and record the discrepancy for the
final report.

- [ ] **Step 3: Record baseline facts and create the backup ref**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
git rev-parse HEAD                                   # record: PRE_REBASE_HEAD (expect 318e9c295…)
git rev-list --count 39010cb57..HEAD                 # record: N_COMMITS (expect 27)
git diff --name-only 39010cb57..HEAD -- src/ test/ shared/ | sort   # record: PRE_CLIENT_FILES
git branch backup/resume-validation-pre-589-rebase HEAD
git rev-parse backup/resume-validation-pre-589-rebase  # expect: same sha as PRE_REBASE_HEAD
```

Expected `PRE_CLIENT_FILES` (the branch's own client footprint — the rebase must not grow it):

```
shared/ws-protocol.ts
src/components/TerminalView.tsx
test/unit/components/TerminalView.lifecycle.test.tsx
```

- [ ] **Step 4: Baseline sanity build**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
cargo check --workspace
```

Run with timeout ≥ 900 s. Expected: exit 0 (the branch was green pre-rebase).
No commit in this task.

---

### Task 2: Rebase onto 2641ada38, resolving the `terminal.rs` conflict per Option A

**Files:**
- Modify (via rebase conflict resolution): `crates/freshell-ws/src/terminal.rs`
- All other branch files replay/auto-merge untouched.

**Interfaces:**
- Consumes: `LaunchPrep` struct (`origin/main terminal.rs:1464`), `derive_launch_prep` (`:1474`), `handle_create` destructure (`:1870-1877`), the branch's gate block (branch `HEAD:terminal.rs:1803-1889`) and its helper `crate::resume_validation::validate_wire_resume(mode, resume_session_id, launch_intent, probe) -> ResumeValidationOutcome` (fields: `resume_session_id: Option<String>`, `launch_intent: LaunchIntent`, `claude_fresh_prealloc: bool`, `stale_session_id: Option<String>`, `notice: Option<String>`).
- Produces: a rebased branch where `LaunchPrep` has a 4th field `pub resume_id_from_wire: bool`, `derive_launch_prep` sets it in exactly one place (the wire `else` arm), and `handle_create` consumes it from the destructure. Tasks 3–5 rely on exactly these names: `LaunchPrep.resume_id_from_wire`, and the gate block keyed `if resume_id_from_wire { … }` sitting after the D7 liveness guard.

- [ ] **Step 1: Start the rebase**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
git rebase 2641ada382472586ce1aa7664331d384853e867d
```

Expected: stops with `CONFLICT (content): Merge conflict in crates/freshell-ws/src/terminal.rs`
while applying `1ed94741d… gate WS terminal.create restore path on disk existence`.
(An earlier stop at `5580abb62` is possible but not expected — if it happens, the
commit only adds the `notice:` field plumbing on `TerminalCreated`; keep both sides:
main's surrounding text + the branch's added `notice` plumbing, then continue.)

- [ ] **Step 2: Resolve `1ed94741d` — extend `LaunchPrep` + `derive_launch_prep` (Option A)**

Open `crates/freshell-ws/src/terminal.rs`. Apply FOUR precise edits, then delete
every conflict marker. Edit 1 — the struct (currently ends with
`claude_fresh_prealloc: bool,`):

```rust
pub(crate) struct LaunchPrep {
    pub launch_intent: LaunchIntent,
    pub resume_session_id: Option<String>,
    pub claude_fresh_prealloc: bool,
    /// Resume-validation tracker (door 1): true only when the resume id above
    /// was derived from the WIRE (sessionRef / legacy resumeSessionId / the
    /// claude restore ladder, which resolves persisted client state) —
    /// server-minted prealloc ids are never gated. Set in exactly ONE place
    /// (the wire `else` arm of derive_launch_prep); never re-computed.
    pub resume_id_from_wire: bool,
}
```

Edit 2 — inside `derive_launch_prep`, add the tracker declaration immediately after
`let mut claude_fresh_prealloc = false;`:

```rust
    let mut claude_fresh_prealloc = false;
    // Resume-validation tracker (door 1): true only when the resume id below
    // was derived from the WIRE (sessionRef / legacy resumeSessionId / the
    // claude restore ladder) — server-minted prealloc ids are never gated.
    let mut resume_id_from_wire = false;
```

Edit 3 — in the same function's trailing `else` arm, immediately after the
`resume_session_id = requested_ref…filter(|s| !s.is_empty());` statement:

```rust
            resume_session_id = requested_ref
                .map(|r| r.session_id.clone())
                .or_else(|| create.resume_session_id.clone())
                .filter(|s| !s.is_empty());
            // Everything this arm can produce came from the wire (or the
            // claude ladder in handle_create, which only runs when this arm
            // ran and resolves persisted client state) — eligible for
            // resume validation.
            resume_id_from_wire = true;
```

Edit 4 — the function's return literal:

```rust
    LaunchPrep {
        launch_intent,
        resume_session_id,
        claude_fresh_prealloc,
        resume_id_from_wire,
    }
}
```

Do NOT set the flag in the `should_preallocate_fresh_claude` arm or the
`should_preallocate_fresh_amplifier` arm — both mint server ids and must stay `false`.

- [ ] **Step 3: Resolve `1ed94741d` — the `handle_create` conflict hunk**

The conflict hunk spans main's `LaunchPrep` destructure + hoisted claude P0.4 ladder
(ours) vs the branch's whole inline derivation (theirs). Resolution: KEEP MAIN'S
STRUCTURE (delete the branch's inline derivation entirely — `derive_launch_prep`
now carries the flag), with mutability + field added to the destructure:

```rust
    let LaunchPrep {
        mut launch_intent,
        mut resume_session_id,
        mut claude_fresh_prealloc,
        resume_id_from_wire,
    } = match prep {
        Some(prep) => prep,
        None => derive_launch_prep(&create, &mode),
    };
```

Keep main's claude P0.4 ladder block that follows (the
`if mode == "claude" && create.restore == Some(true) { … }` block with the
`is_canonical_claude_session_id` / `resolve_claude_restore_session_id` /
`RestoreUnavailable` rungs) EXACTLY as main has it — including its
"Do not move it" comment. Keep main's D7 liveness guard after it, unchanged.
Audit the closing braces by eye: the two sides close different brace depths, so
a naive take-ours/take-theirs does not compile — the resolved region must be:
destructure → ladder → D7 guard.

- [ ] **Step 4: Resolve `1ed94741d` — the gate block itself**

The branch's gate hunk (its `HEAD:1803-1889` block) inserts AFTER the D7 guard and
BEFORE the amplifier `ensure_session` re-stub. If git placed it cleanly, verify it;
if it landed inside conflict markers, re-insert it verbatim at that position. It must
read exactly as on the branch (same comments), starting:

```rust
    // Resume validation (docs/plans/2026-07-29-resume-validation.md): never
    // hand the CLI a resume id that is definitively absent from the
    // provider's on-disk store. Fail open on Unknown/ProviderUnavailable.
    // Placed AFTER the D7 liveness guard (a gate fire would falsify D7's
    // applicability filter and retire a running session's Bound row) and
    // BEFORE the amplifier ensure_session re-stub (which would resurrect
    // the stale dir).
    let mut resume_fallback_notice: Option<String> = None;
    if resume_id_from_wire {
```

…followed by the branch's `candidate_is_live` join (registry + async `fresh_*`
sidecar arms), the `spawn_blocking` call to
`crate::resume_validation::validate_wire_resume`, the outcome application
(`resume_session_id = outcome.resume_session_id; launch_intent = outcome.launch_intent;
if outcome.claude_fresh_prealloc { claude_fresh_prealloc = true; }`), and the
stale-fire arm (`tracing::warn!`, `session_ref_lease = None;`, the
`ledger.retire_missing(...)` spawn_blocking, `resume_fallback_notice = outcome.notice;`).
Recover the exact text with:

```bash
git -C /home/dan/code/freshell/.worktrees/resume-validation show REBASE_HEAD:crates/freshell-ws/src/terminal.rs | sed -n '1803,1889p'
```

(`REBASE_HEAD` is the commit being replayed, i.e. the branch's `1ed94741d`.)

- [ ] **Step 5: Verify the resolution compiles, then continue**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
grep -n '<<<<<<<\|=======\|>>>>>>>' crates/freshell-ws/src/terminal.rs   # expect: no output
cargo check -p freshell-ws                                              # expect: exit 0
git add crates/freshell-ws/src/terminal.rs
git rebase --continue
```

Keep the original commit message. Expected: the rebase proceeds.

- [ ] **Step 6: Handle any later stops with these fixed rules**

Rules, in order: (1) prefer MAIN's structural text for regions #589 rewrote
(destructure, ladder position, plan sites, `prepare_launch`); (2) keep the branch's
ADDITIONS (gate block, door-2 respawn gate, notice plumbing, tests, docs);
(3) stay consistent with Steps 2–4 — the flag lives ONLY in `derive_launch_prep`;
(4) if a replayed commit becomes empty because main already contains its change,
verify with `git diff --cached --stat` that it is truly empty, then `git rebase --skip`
and record which commit was skipped. Expected candidates for a stop: `e13a6b787`
(the branch's earlier S5-reconciliation of `terminal.rs`) — for it, keep main's
text wherever both sides express the same S5/#582/#584 reconciliation and keep any
branch-only additions. After each resolution: the same `grep` for markers +
`cargo check -p freshell-ws` before `git rebase --continue`.

- [ ] **Step 7: Post-rebase structural verification**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
git status --porcelain                       # expect: empty (rebase finished)
git merge-base HEAD 2641ada382472586ce1aa7664331d384853e867d   # expect: 2641ada38247…
git rev-list --count 2641ada38..HEAD         # expect: 27 (or 27 minus recorded skips)
git grep -n resume_id_from_wire -- crates/   # expect: exactly the derive decl+set, struct field, destructure, gate predicate — all in terminal.rs
git diff --name-only 39010cb57..backup/resume-validation-pre-589-rebase -- src/ test/ shared/ | sort > /tmp/pre_client.txt
git diff --name-only 2641ada38..HEAD -- src/ test/ shared/ | sort > /tmp/post_client.txt
diff /tmp/pre_client.txt /tmp/post_client.txt && echo CLIENT-FOOTPRINT-UNCHANGED
```

Expected: all as annotated; `CLIENT-FOOTPRINT-UNCHANGED` prints.

- [ ] **Step 8: Post-rebase compile + targeted non-ignored sweep**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
cargo check --workspace
cargo test -p freshell-ws --test resume_validation_gate
cargo test -p freshell-ws --test auto_resume_respawn
cargo test -p freshell-freshagent --lib rest_resume_
cargo test -p freshell-ws --test restore_storm
cargo test -p freshell-ws --test restore_plan_queue_cap
cargo test -p freshell-ws --lib resume_validation
cargo test -p freshell-platform --lib resume_gate
```

Run with timeout ≥ 1200 s each where needed. Expected: ALL PASS. (The `#[ignore]`d
`managed_default_stale_codex_id_is_gated_before_planning` is deliberately NOT run
here — it is Task 5's red test.) If a storm pin fails, first inspect whether the
gate fired inside the storm harness (it must not: the harness's default
`WsState.session_existence` probe answers Unknown → fail-open); report findings
honestly rather than papering over.

No new commit — the rebase itself rewrote history. Record the post-rebase HEAD sha.

---

### Task 3: First direct unit tests on `derive_launch_prep` — pin `resume_id_from_wire` origin semantics

**Files:**
- Create: `crates/freshell-ws/src/terminal_launch_prep_tests.rs`
- Modify: `crates/freshell-ws/src/terminal.rs` (one 3-line test-module hook, next to the existing `#[cfg(test)] #[path = "terminal_create_ordering_tests.rs"]` hook at `terminal.rs:71-73`)

**Interfaces:**
- Consumes: `derive_launch_prep(&TerminalCreate, &str) -> LaunchPrep` and `LaunchPrep { launch_intent, resume_session_id, claude_fresh_prealloc, resume_id_from_wire }` from Task 2; `TerminalCreate` (deserializable, `#[serde(rename_all = "camelCase")]`, fields `requestId`, `mode`, `restore`, `resumeSessionId`, `sessionRef{provider,sessionId}`); `LaunchIntent::{Start, Resume}`.
- Produces: test module `terminal_launch_prep_tests` — Task 4's mutation-proof step reruns it by name.

- [ ] **Step 1: Register the sibling test file**

In `crates/freshell-ws/src/terminal.rs`, directly below the existing
`terminal_create_ordering_tests` hook (`:71-73` region), add:

```rust
#[cfg(test)]
#[path = "terminal_launch_prep_tests.rs"]
mod terminal_launch_prep_tests;
```

- [ ] **Step 2: Write the failing/proving tests**

Create `crates/freshell-ws/src/terminal_launch_prep_tests.rs`:

```rust
//! First direct unit tests for derive_launch_prep (it previously had only
//! indirect integration coverage). Pins the ORIGIN semantics of
//! LaunchPrep.resume_id_from_wire: true only for wire-derived resume ids,
//! false for BOTH server-prealloc arms (claude fresh prealloc AND the
//! amplifier launcher-assigned identity) and for mode == "shell".
use super::*;

fn create_from_json(v: serde_json::Value) -> TerminalCreate {
    serde_json::from_value(v).expect("valid TerminalCreate json")
}

#[test]
fn wire_session_ref_restore_is_from_wire() {
    let create = create_from_json(serde_json::json!({
        "requestId": "r-wire-ref",
        "mode": "codex",
        "restore": true,
        "sessionRef": { "provider": "codex", "sessionId": "stale-codex-id" }
    }));
    let prep = derive_launch_prep(&create, "codex");
    assert!(prep.resume_id_from_wire, "sessionRef carrier is wire-originated");
    assert_eq!(prep.resume_session_id.as_deref(), Some("stale-codex-id"));
    assert!(!prep.claude_fresh_prealloc);
    assert!(matches!(prep.launch_intent, LaunchIntent::Resume));
}

#[test]
fn wire_legacy_resume_session_id_is_from_wire() {
    let create = create_from_json(serde_json::json!({
        "requestId": "r-wire-legacy",
        "mode": "amplifier",
        "restore": true,
        "resumeSessionId": "stale-amp-id"
    }));
    let prep = derive_launch_prep(&create, "amplifier");
    assert!(prep.resume_id_from_wire, "legacy resumeSessionId carrier is wire-originated");
    assert_eq!(prep.resume_session_id.as_deref(), Some("stale-amp-id"));
}

#[test]
fn claude_fresh_prealloc_is_server_allocated_not_wire() {
    let create = create_from_json(serde_json::json!({
        "requestId": "r-claude-fresh",
        "mode": "claude"
    }));
    let prep = derive_launch_prep(&create, "claude");
    assert!(prep.claude_fresh_prealloc);
    assert!(matches!(prep.launch_intent, LaunchIntent::Start));
    let minted = prep.resume_session_id.expect("prealloc mints a fresh id");
    uuid::Uuid::parse_str(&minted).expect("minted id is a uuid");
    assert!(
        !prep.resume_id_from_wire,
        "server-preallocated claude id must NEVER be gate-eligible"
    );
}

#[test]
fn amplifier_fresh_prealloc_is_server_allocated_not_wire() {
    // THE TRAP CASE: amplifier prealloc mints a server id while
    // claude_fresh_prealloc stays false — the flag must still be false.
    let create = create_from_json(serde_json::json!({
        "requestId": "r-amp-fresh",
        "mode": "amplifier"
    }));
    let prep = derive_launch_prep(&create, "amplifier");
    assert!(!prep.claude_fresh_prealloc);
    assert!(matches!(prep.launch_intent, LaunchIntent::Resume));
    let minted = prep.resume_session_id.expect("amplifier prealloc mints a fresh id");
    uuid::Uuid::parse_str(&minted).expect("minted id is a uuid");
    assert!(
        !prep.resume_id_from_wire,
        "server-minted amplifier id must NEVER be gate-eligible"
    );
}

#[test]
fn shell_mode_is_never_from_wire() {
    let create = create_from_json(serde_json::json!({
        "requestId": "r-shell",
        "mode": "shell"
    }));
    let prep = derive_launch_prep(&create, "shell");
    assert!(!prep.resume_id_from_wire);
    assert!(prep.resume_session_id.is_none());
}
```

If `serde_json::from_value` panics on a missing required field (e.g. `shell`),
copy the exact payload shape emitted by the proven builder
`restore_create_with_session_ref` at
`crates/freshell-ws/tests/resume_validation_gate.rs:407` (minus the outer
`"type": "terminal.create"` envelope if `TerminalCreate` is the payload struct)
and add the missing fields to every JSON literal above. Adjust `use super::*;`
imports if `uuid`/`serde_json` need explicit paths — mirror the imports of the
neighboring `terminal_create_ordering_tests.rs`.

- [ ] **Step 3: Run the new tests**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
cargo test -p freshell-ws --lib terminal_launch_prep_tests
```

Expected: 5 passed. (These pass immediately because Task 2 already added the field —
Step 4 proves they are load-bearing, which is the honest "prove first" for a
rebase-introduced field.)

- [ ] **Step 4: Mutation-proof the tests (prove they bite)**

Temporarily add `resume_id_from_wire = true;` inside the
`if should_preallocate_fresh_claude {` arm of `derive_launch_prep`, then:

```bash
cargo test -p freshell-ws --lib terminal_launch_prep_tests
```

Expected: `claude_fresh_prealloc_is_server_allocated_not_wire` FAILS. Now REVERT the
mutation (`git checkout -- crates/freshell-ws/src/terminal.rs` is NOT usable — the
file also holds Step 1's hook; revert the one line by hand), rerun, expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/terminal_launch_prep_tests.rs
git commit -m "test(ws): first direct unit tests for derive_launch_prep — pin resume_id_from_wire origin semantics"
```

---

### Task 4: Gate-level pin — server-allocated ids are NEVER gated, even when absent on disk

**Files:**
- Modify: `crates/freshell-ws/tests/resume_validation_gate.rs` (append probe + 2 tests)

**Interfaces:**
- Consumes: the file's own harness — `spawn_server_with_probe(probe, fresh_agent_enabled)`, `common::isolate_amplifier_home()`, `common::connect_and_capture_inventory`, `send_json`, `next_created_or_error`, `notice_of`, `restore_create_with_session_ref(request_id, mode, session_id)`, the `SessionExistenceProbe` trait (methods incl. `exists_for_gate`) and `SessionExistence::Absent`, plus `StubProbe` (`:28-60`) as the impl template.
- Produces: tests `server_allocated_fresh_claude_id_is_never_gated` and `server_allocated_fresh_amplifier_id_is_never_gated`; probe type `AlwaysAbsentProbe`.

- [ ] **Step 1: Add an always-Absent probe**

`StubProbe` defaults unmatched keys to `Unknown` (fail-open), which would make this
test pass for the WRONG reason. Add, next to `StubProbe`, a probe that answers
`Absent` for EVERY query — copy `StubProbe`'s `impl SessionExistenceProbe` block
shape exactly (same method names/signatures, at minimum `exists_for_gate`; if the
trait has more required methods, answer `SessionExistence::Absent` from each):

```rust
/// Answers Absent for EVERY (provider, id) query — including ids minted
/// server-side that the test cannot know in advance. If the gate ever
/// consults the probe for a server-allocated id, it will fire and the
/// assertions below will catch it.
struct AlwaysAbsentProbe;

impl SessionExistenceProbe for AlwaysAbsentProbe {
    fn exists_for_gate(&self, _provider: &str, _session_id: &str) -> SessionExistence {
        SessionExistence::Absent
    }
}
```

(Adjust method list/signatures to match `StubProbe`'s impl verbatim — that impl is
the source of truth in this file.)

- [ ] **Step 2: Write the two failing/proving tests**

Append to `crates/freshell-ws/tests/resume_validation_gate.rs`. The fresh-create
frame is derived from the proven restore builder so the envelope shape can never
drift:

```rust
fn fresh_create(request_id: &str, mode: &str) -> serde_json::Value {
    // Same envelope as a restore create, minus every resume carrier — this
    // is the shape that triggers the server prealloc arms.
    let mut v = restore_create_with_session_ref(request_id, mode, "unused");
    let obj = v.as_object_mut().expect("create frame is an object");
    obj.remove("restore");
    obj.remove("sessionRef");
    obj.remove("resumeSessionId");
    v
}

/// A fresh claude create mints a SERVER-allocated session id (prealloc).
/// That id is by definition absent on disk — and must NEVER be gated:
/// no notice, plain successful create. Probe answers Absent for everything,
/// so any gate consult on the minted id would fire and fail this test.
#[tokio::test(flavor = "multi_thread")]
async fn server_allocated_fresh_claude_id_is_never_gated() {
    let (url, registry, _ledger, _state) =
        spawn_server_with_probe(AlwaysAbsentProbe, false).await;

    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;
    send_json(&mut ws, &fresh_create("req-prealloc-claude", "claude")).await;
    let frame = next_created_or_error(&mut ws, "req-prealloc-claude").await;

    assert_eq!(
        frame["type"], "terminal.created",
        "fresh claude create must succeed, got {frame}"
    );
    assert!(
        notice_of(&frame).is_none(),
        "server-allocated claude prealloc id must never trip the gate notice"
    );

    registry.kill_all();
}

/// The amplifier sibling (THE TRAP: claude_fresh_prealloc == false here, yet
/// the id is still server-minted): a fresh amplifier create must never gate.
#[tokio::test(flavor = "multi_thread")]
async fn server_allocated_fresh_amplifier_id_is_never_gated() {
    let (url, registry, _ledger, _state) =
        spawn_server_with_probe(AlwaysAbsentProbe, false).await;
    let _amp_home = common::isolate_amplifier_home();

    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;
    send_json(&mut ws, &fresh_create("req-prealloc-amp", "amplifier")).await;
    let frame = next_created_or_error(&mut ws, "req-prealloc-amp").await;

    assert_eq!(
        frame["type"], "terminal.created",
        "fresh amplifier create must succeed, got {frame}"
    );
    assert!(
        notice_of(&frame).is_none(),
        "server-minted amplifier id must never trip the gate notice"
    );

    registry.kill_all();
}
```

If `spawn_server_with_probe`'s parameter is a concrete `StubProbe` type rather
than `impl SessionExistenceProbe`, generalize the parameter to
`impl SessionExistenceProbe + Send + Sync + 'static` (matching how the probe is
stored in `WsState.session_existence`) — a test-harness-only change in this file.

- [ ] **Step 3: Run the new tests**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
cargo test -p freshell-ws --test resume_validation_gate server_allocated_
```

Expected: 2 passed.

- [ ] **Step 4: Mutation-proof (prove they bite)**

Re-apply Task 3 Step 4's mutation (`resume_id_from_wire = true;` in the claude
prealloc arm of `derive_launch_prep`), run:

```bash
cargo test -p freshell-ws --test resume_validation_gate server_allocated_fresh_claude_id_is_never_gated
```

Expected: FAILS (gate fires on the minted id, notice appears). Revert the one-line
mutation, rerun, expected: PASS.

- [ ] **Step 5: Run the whole gate suite, then commit**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
cargo test -p freshell-ws --test resume_validation_gate
git add crates/freshell-ws/tests/resume_validation_gate.rs
git commit -m "test(ws): pin server-allocated resume ids are never gated (claude + amplifier prealloc)"
```

Expected: all non-ignored tests in the target pass before committing.

---

### Task 5: Gate-before-plan reconciliation — run the codex wire-resume gate OFF-permit in `prepare_launch`

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (new `ResumeGateCarry` struct + `gate_wire_resume` helper; `PreparedLaunch` gains a field; `prepare_launch` gains the pre-plan gate; `handle_create`'s gate site becomes carry-aware)

**Interfaces:**
- Consumes: `PreparedLaunch { prep, codex_launch }` and `prepare_launch` (main `terminal.rs:1584-1647`), the `handle_create` top destructure (`:1665-1672`), the gate block from Task 2, `LaunchPrep.resume_id_from_wire`.
- Produces: `pub(crate) struct ResumeGateCarry { pub notice: Option<String>, pub stale_session_id: Option<String> }`; `async fn gate_wire_resume(state: &WsState, mode: &str, resume_session_id: &mut Option<String>, launch_intent: &mut LaunchIntent, claude_fresh_prealloc: &mut bool) -> ResumeGateCarry`; `PreparedLaunch.resume_gate: Option<ResumeGateCarry>`. Task 7 relies on the final ordering this task pins.

**Why (record in code comments, per the locked spec):** #589 plans codex
restore-class launches OFF-permit in `prepare_launch`, BEFORE the permit. Task 2's
tree therefore plans BEFORE the gate for codex wire ids — violating gate-before-plan
(a stale id must never invoke managed-launch planning nor consume a sidecar planning
slot). Fix: run the gate inside `prepare_launch`, before `plan_codex_managed_launch`.
Final ordering for codex restore-class creates: **gate → plan (off-permit) → permit
→ spawn**. Non-codex modes have NO off-permit plan step, so their gate stays at the
branch's `handle_create` position (post-ladder, post-D7 — which also keeps
ladder-resolved claude ids gated, and keeps the off-permit gate from ever seeing a
pre-ladder non-canonical claude id). The codex-scoped off-permit gate never runs on
reconnect paths — `prepare_launch` is a spawn-door (restore-create) caller only.

- [ ] **Step 1: RED — run the ignored ordering pin, expect FAIL**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
cargo test -p freshell-ws --test resume_validation_gate \
  managed_default_stale_codex_id_is_gated_before_planning -- --ignored --test-threads=1
```

Expected: FAIL — post-rebase, `prepare_launch` plans the codex sidecar for the
stale id before the `handle_create` gate can drop it. Record the failure output.
If it PASSES here, STOP and investigate how the create under test reaches planning
(it may bypass `prepare_launch`); do not proceed on an unverified premise — report
what you find.

- [ ] **Step 2: Add `ResumeGateCarry` and factor the gate body into `gate_wire_resume`**

In `crates/freshell-ws/src/terminal.rs`, next to `PreparedLaunch`, add:

```rust
/// Outcome of the wire-resume disk-existence gate, carried from wherever the
/// gate ran (off-permit in prepare_launch for codex; on-permit in
/// handle_create for everything else) to the single place that emits the
/// operator notice and releases the D8 stale-ref lease.
pub(crate) struct ResumeGateCarry {
    pub notice: Option<String>,
    pub stale_session_id: Option<String>,
}
```

Then add the helper — its body is Task 2's gate block MOVED verbatim (liveness
join, spawn_blocking probe, outcome application, warn + `retire_missing`), minus
the `resume_fallback_notice` / `session_ref_lease` lines which stay in
`handle_create`:

```rust
/// Resume validation (docs/plans/2026-07-29-resume-validation.md): never hand
/// the CLI a resume id that is definitively absent from the provider's
/// on-disk store. Fail open on Unknown/ProviderUnavailable; a LIVE session
/// never gates (same join D7 uses: registry + async fresh-agent sidecar
/// arms). The probe's by-id locators do real filesystem walks (~1 s for
/// codex) — spawn-door callers only, never inline on the async runtime.
async fn gate_wire_resume(
    state: &WsState,
    mode: &str,
    resume_session_id: &mut Option<String>,
    launch_intent: &mut LaunchIntent,
    claude_fresh_prealloc: &mut bool,
) -> ResumeGateCarry {
    let candidate_is_live = match resume_session_id.as_deref() {
        None => false,
        Some(sid) => {
            let registry_row_live = state
                .registry
                .live_session_owner(Some(&state.identity), mode, sid)
                .is_some();
            let fresh_agent_live = !registry_row_live
                && match mode {
                    "claude" => state.fresh_claude.has_live_session(sid).await,
                    "codex" => state.fresh_codex.has_live_session(sid).await,
                    "opencode" => state.fresh_opencode.has_live_session(sid).await,
                    _ => false,
                };
            registry_row_live || fresh_agent_live
        }
    };
    if candidate_is_live {
        return ResumeGateCarry { notice: None, stale_session_id: None };
    }
    let outcome = {
        let probe = state.session_existence.clone();
        let mode_for_gate = mode.to_string();
        let rid = resume_session_id.take();
        let intent = *launch_intent;
        tokio::task::spawn_blocking(move || {
            crate::resume_validation::validate_wire_resume(
                &mode_for_gate,
                rid,
                intent,
                probe.as_ref(),
            )
        })
        .await
        .expect("resume validation task panicked")
    };
    *resume_session_id = outcome.resume_session_id;
    *launch_intent = outcome.launch_intent;
    if outcome.claude_fresh_prealloc {
        *claude_fresh_prealloc = true;
    }
    if let Some(stale) = outcome.stale_session_id.as_deref() {
        tracing::warn!(
            mode = %mode,
            stale_session_id = %stale,
            "resume validation: cached session missing on disk; spawning fresh"
        );
        // Don't retry the stale id forever — retire the pane-ledger row on
        // the blocking pool (same fsync discipline as every ledger write).
        let ledger = std::sync::Arc::clone(&state.pane_ledger);
        let retire_mode = mode.to_string();
        let stale_id = stale.to_string();
        let _ = tokio::task::spawn_blocking(move || {
            ledger.retire_missing(&retire_mode, &stale_id)
        })
        .await;
    }
    ResumeGateCarry {
        notice: outcome.notice,
        stale_session_id: outcome.stale_session_id,
    }
}
```

Preserve the original block's inline comments (liveness SHAPE NOTE, A13
spawn_blocking rationale, retire discipline) — move them with the code. If
`LaunchIntent` is not `Copy`, use `.clone()` instead of `*launch_intent` for
`intent`.

- [ ] **Step 3: Extend `PreparedLaunch` and gate inside `prepare_launch`**

```rust
pub(crate) struct PreparedLaunch {
    pub prep: LaunchPrep,
    /// Some(..) ONLY when a resume session id was derived; None means
    /// "not planned pre-gate" and handle_create plans on-permit inline.
    pub codex_launch: Option<PreparedCodexLaunch>,
    /// Some(..) iff the wire-resume gate already ran off-permit (codex
    /// restore-class creates) — handle_create must then NOT run it again,
    /// only apply the carried notice / stale-ref lease release.
    pub resume_gate: Option<ResumeGateCarry>,
}
```

In `prepare_launch`, change `let prep = derive_launch_prep(create, &mode);` to
`let mut prep = derive_launch_prep(create, &mode);` and insert BETWEEN the derive
and the existing `let codex_launch = if prep.resume_session_id.is_some() { … }`
plan site:

```rust
    // Resume-validation door 1, codex leg (reconciled with #589): codex
    // restore-class planning happens OFF-permit right below, so the
    // disk-existence gate for codex WIRE ids must run before it — a
    // definitively-absent stale id must never invoke managed-launch
    // planning nor consume a sidecar planning slot. Final ordering here:
    // gate -> plan (off-permit) -> permit -> spawn. Non-codex modes have no
    // off-permit plan step; they keep the on-permit gate inside
    // handle_create (post-ladder, post-D7), byte-identical to the branch.
    let resume_gate = if mode == "codex" && prep.resume_id_from_wire {
        Some(
            gate_wire_resume(
                state,
                &mode,
                &mut prep.resume_session_id,
                &mut prep.launch_intent,
                &mut prep.claude_fresh_prealloc,
            )
            .await,
        )
    } else {
        None
    };
```

…and change the return to `Ok(PreparedLaunch { prep, codex_launch, resume_gate })`.
Note the emergent win: when the gate FIRES for codex it drops the resume id, so
`prep.resume_session_id` is `None` at the plan site → no off-permit plan is made
at all (the A4 exclusion), and `handle_create` later plans on-permit
`LaunchClass::Interactive` exactly like a fresh create — no stale
`PreparedCodexLaunch` can ever exist.

- [ ] **Step 4: Make `handle_create`'s gate site carry-aware**

In `handle_create`, extend the top destructure to extract the carry:

```rust
    let (prep, mut prepared_codex, prepared_resume_gate) = match prepared {
        Some(p) => (Some(p.prep), p.codex_launch, p.resume_gate),
        None => (None, None, None),
    };
```

Replace Task 2's whole `let mut resume_fallback_notice … if resume_id_from_wire { … }`
gate block (keeping its position: after the D7 guard, before the amplifier
`ensure_session` re-stub) with:

```rust
    // Resume validation (docs/plans/2026-07-29-resume-validation.md). The
    // codex leg already ran OFF-permit in prepare_launch (gate-before-plan);
    // every other wire-id create gates here — after the D7 liveness guard
    // (a gate fire would falsify D7's applicability filter) and after the
    // claude P0.4 ladder (ladder-resolved ids are wire-originated and must
    // be validated), before the amplifier ensure_session re-stub (which
    // would resurrect the stale dir).
    let mut resume_fallback_notice: Option<String> = None;
    let resume_gate_carry = match prepared_resume_gate {
        Some(carry) => Some(carry),
        None if resume_id_from_wire => Some(
            gate_wire_resume(
                state,
                &mode,
                &mut resume_session_id,
                &mut launch_intent,
                &mut claude_fresh_prealloc,
            )
            .await,
        ),
        None => None,
    };
    if let Some(carry) = resume_gate_carry {
        if carry.stale_session_id.is_some() {
            // Stale-ref stamping guard: this create no longer creates the
            // wire sessionRef's session, so a D8 lease claimed for the
            // STALE ref must be RELEASED, never completed (completing it
            // would bind stale-ref->terminal in the registry binding map).
            // Dropping the armed guard runs fail_session_ref_claim.
            session_ref_lease = None;
            resume_fallback_notice = carry.notice;
        }
    }
```

- [ ] **Step 5: Compile + clippy the crate**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
cargo check -p freshell-ws
cargo clippy -p freshell-ws --all-targets -- -D warnings
```

Expected: exit 0 both. If any other code constructs `PreparedLaunch` literally
(the compiler will say so), add `resume_gate: None` there.

- [ ] **Step 6: GREEN — the ignored ordering pin now passes**

```bash
cargo test -p freshell-ws --test resume_validation_gate \
  managed_default_stale_codex_id_is_gated_before_planning -- --ignored --test-threads=1
```

Expected: PASS.

- [ ] **Step 7: Re-run every interaction surface**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
cargo test -p freshell-ws --test resume_validation_gate
cargo test -p freshell-ws --test auto_resume_respawn
cargo test -p freshell-freshagent --lib rest_resume_
cargo test -p freshell-ws --test restore_storm
cargo test -p freshell-ws --test restore_plan_queue_cap
cargo test -p freshell-ws --lib terminal_launch_prep_tests
```

Timeout ≥ 1200 s where needed. Expected: ALL PASS — including the five storm pins
(their harness probe answers Unknown → the new off-permit gate fails open and only
adds a no-op consult) and Task 4's `server_allocated_*` pins.

- [ ] **Step 8: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
git add crates/freshell-ws/src/terminal.rs
git commit -m "fix(ws): run the codex wire-resume gate off-permit before planning — reconcile resume-validation gate-before-plan with #589"
```

---

### Task 6: Docs truth-up — deviation ledger vs the new door-1 wiring

**Files:**
- Modify (only if false statements found): `port/oracle/DEVIATIONS.md`
- Do NOT edit the dated plan docs (`docs/plans/2026-07-29-resume-validation.md`, `docs/plans/2026-07-30-resume-validation.md`) — they are historical records of past runs, not living docs.

**Interfaces:**
- Consumes: Task 5's final wiring (codex leg off-permit in `prepare_launch`; other modes on-permit in `handle_create`).
- Produces: a deviation ledger that states the true door-1 ordering.

- [ ] **Step 1: Find ordering claims in the ledger**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
grep -n -i "resume.validation\|resume_id_from_wire\|gate" port/oracle/DEVIATIONS.md | head -50
```

Read the branch's deviation entry (added by `4685c10c7`, reconciled by `ae05f50ad` /
DEV-0010). Statements that are NOW FALSE and must be amended if present: claims that
the door-1 gate runs only inside `handle_create`, or that it runs after the spawn-gate
permit for ALL modes, or any ordering claim contradicted by "codex wire ids gate
off-permit in `prepare_launch`, before managed-launch planning; other modes gate
on-permit in `handle_create` post-ladder/post-D7".

- [ ] **Step 2: Amend only the false sentences**

Edit the specific sentences in the deviation entry to state the Task 5 ordering,
e.g. append to the door-1 wiring description:

```markdown
(Reconciled with PR #589's off-permit restore planning: for codex restore-class
creates the gate runs OFF-permit inside `prepare_launch`, BEFORE
`plan_codex_managed_launch` — gate → plan (off-permit) → permit → spawn — so a
stale id never consumes a sidecar planning slot. All other modes keep the
on-permit gate in `handle_create` (post-ladder, post-D7); the gate outcome is
carried via `PreparedLaunch.resume_gate` so notice emission and D8 stale-ref
lease release stay single-sited.)
```

If NOTHING in the ledger is false (grep found no contradicted claims), record that
finding and SKIP Step 3 — this task then produces no commit, which is the correct
outcome per the spec ("update ONLY if they now state something false").

- [ ] **Step 3: Commit (only if Step 2 changed anything)**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
git add port/oracle/DEVIATIONS.md
git commit -m "docs: reconcile deviation ledger with off-permit codex gate placement (#589 rebase)"
```

---

### Task 7: Full verification and final history review

**Files:**
- None modified (verification only; any failure loops back to the offending task).

**Interfaces:**
- Consumes: everything above; Task 1's recorded baselines.
- Produces: the final green receipt for the orchestrator (which lands the branch — this plan never pushes).

- [ ] **Step 1: Formatting and lints (CI-exact)**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: both exit 0. Fix any fallout in place (amend into the responsible task's
commit with `git commit --fixup=<sha>` + `git rebase --autosquash -i 2641ada38` only
if trivial formatting; otherwise a focused follow-up commit).

- [ ] **Step 2: Full Rust workspace suite (LONG)**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
cargo test --workspace
```

Run with timeout ≥ 3600 s. Expected: all pass.

- [ ] **Step 3: Host-gated ignored e2e legs (run alone, serially)**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
cargo test -p freshell-ws --test resume_validation_gate -- --ignored --test-threads=1
cargo test -p freshell-ws --test codex_managed_launch_e2e -- --ignored --test-threads=1
```

Timeout ≥ 1200 s each. Expected: pass (skip the second command gracefully if that
test target does not exist post-rebase — verify with
`ls crates/freshell-ws/tests/ | grep codex_managed` first).

- [ ] **Step 4: Wire-contract check (branch touches freshell-protocol + shared/ws-protocol.ts)**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
cargo test -p freshell-protocol --locked
npm run contract:generate && git diff --exit-code -- port/contract
```

Expected: tests pass; `git diff` exits 0 (schema unchanged by the rebase). If
`contract:generate` needs node deps that aren't installed in this worktree, run
`npm ci` first (build tooling only — not a test run, no coordinator gate needed).

- [ ] **Step 5: Client-suite gate — run ONLY if the rebase touched client files**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
git diff --name-only 2641ada38..HEAD -- src/ test/ shared/ | sort
```

Expected output is EXACTLY Task 1's `PRE_CLIENT_FILES` list (the branch's own three
files). If so: SKIP the JS suite (the rebase is Rust-only — #589 touched no client
files) and record that decision. If the list grew: run the coordinated client suite —

```bash
npm run test:status   # wait politely if another agent holds the gate
FRESHELL_TEST_SUMMARY="resume-validation #589 rebase touched client files" npm run test:unit
```

(Reminder: `terminal-font-settings.test.tsx` failing is a known pre-existing
main-side issue — note it, don't chase it.)

- [ ] **Step 6: Final history review**

```bash
cd /home/dan/code/freshell/.worktrees/resume-validation
git merge-base HEAD 2641ada382472586ce1aa7664331d384853e867d   # expect 2641ada38247…
git log --oneline 2641ada38..HEAD
git log --format='%an <%ae>' 2641ada38..HEAD | sort -u          # expect exactly: Dan Shapiro <3732858+danshapiro@users.noreply.github.com>
git status --porcelain                                          # expect empty
```

Expected: 27 replayed commits (minus any recorded empty-skips) + 2–4 reconciliation
commits (Tasks 3, 4, 5, optional 6), every message Conventional-Commits-shaped, no
stray WIP/fixup commits, clean tree. Confirm the backup ref still exists
(`git rev-parse backup/resume-validation-pre-589-rebase`). **Do NOT push, do NOT
open a PR, do NOT delete the backup ref** — report the final HEAD sha, the pass/fail
table of Steps 1–5, any skipped-empty commits, and any origin/main-moved discrepancy
from Task 1.

---

## Self-review record

- **Spec coverage:** Required work 1 (rebase + Option A + consistent later resolutions) → Tasks 1–2. Required work 2 (TDD unit test on `derive_launch_prep` for wire-vs-server-allocated + gate-level never-gated assertion) → Tasks 3–4 (with mutation-proof steps making the "prove" honest, since the field lands during the rebase). Required work 3 (re-run branch gate tests, auto_resume, rest_resume_, managed-path characterization, #589 storm pins) → Task 2 Step 8, Task 5 Steps 1/6/7, Task 7. Required work 4 (fmt/clippy/workspace tests/client-if-touched, known font-settings caveat) → Task 7. Required work 5 (clean history, reconciliation commit messages, docs only-if-false) → Tasks 5–7. The explicit ordering interaction (gate → plan-off-permit → permit → spawn, or documented alternative) → Task 5, which implements the blessed ordering for codex and documents in code why non-codex modes gate on-permit (no off-permit plan step exists for them; ladder-resolved claude ids must be validated post-ladder).
- **No silent deferrals:** No stubs or fakes stand in for required behavior; the only test doubles are the pre-existing harness probes (`StubProbe`, plus the new `AlwaysAbsentProbe`), and the real-probe production path is exercised by the branch's existing `freshell-server` existence tests which run in Task 7's workspace sweep. No requirement was moved to "known limitations". **UNRESOLVED COVERAGE GAPS: none.**
- **Placeholder scan:** every code step carries complete code; the two places where a repo detail could not be pinned read-only (TerminalCreate serde defaults; the exact `SessionExistenceProbe` method list) carry a deterministic in-repo fallback (copy the named proven builder/impl at an exact file:line), not a TBD.
- **Type consistency:** `LaunchPrep.resume_id_from_wire: bool` (Tasks 2/3/5), `ResumeGateCarry { notice, stale_session_id }` + `gate_wire_resume(state, mode, &mut Option<String>, &mut LaunchIntent, &mut bool)` (Task 5 both call sites), `PreparedLaunch.resume_gate: Option<ResumeGateCarry>` (Task 5 Steps 3–4), test names in Task 4 Step 2 match Step 3/4 run filters — all cross-checked.
