# Fast, Exact, Automatic Session Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use
> `subagent-driven-development` through `executing-plans`. Execute each task
> with red-green-refactor TDD, review it, and commit it before starting the
> next task.

**Goal:** After a Freshell server restart, every pane whose durable session can
be positively proved begins restoring immediately, without waiting for the
full History scan and without asking the user to press “Retry now.”

**User-visible result:** In the ordinary case the existing tabs simply return.
There is no recovery pop-up and no all-at-once create burst. If Freshell cannot
prove a saved session yet, that pane remains safely paused while Freshell
retries. A short-lived “Restoring…” status appears only after 750 ms. After a
bounded retry episode, the pane says in plain language that its saved session
could not be found or read and offers explicit Retry and Start new actions;
Freshell never guesses.

**Architecture:** Replace cold-History existence checks with a closed registry
of durable recovery providers. A new leaf `freshell-recovery` crate supplies
the shared query/result contract, bounded coordinator, and one cross-kind
session-ownership arbiter used by terminal and fresh-agent launch paths. A
reconcile request is reduced to unique provider/session/cwd queries, admitted
through a four-job global gate, and resolved in one provider-batched blocking
job. Results live only for that request. Only an ownership-proved positive is
actionable; misses, partial artifacts, read failures, stale database rows, and
conflicts are retryable or actionable errors, never `Absent`. Registry and
ledger authority are re-read after the blocking job. Every restore door claims
the global session owner, revalidates exact proof before any provider setup,
and requires a launch-nonce-bound initial identity acknowledgement before the
claim becomes a durable binding. One client-side controller owns boot
reconcile, chunks above the 200-pane wire cap, automatic/manual retry,
reconnect, create holds, and pane removal.

**Tech stack:** Rust 2024 workspace (Tokio, Axum/WebSocket, rusqlite, notify,
zstd), React 18, Redux Toolkit, TypeScript, Vitest, Playwright.

---

## Acceptance Contract

- The incident-shaped test presents 17 unique durable panes.
- All 17 exact verdicts arrive on the first request within 500 ms p95 from
  `ready`, measured over 20 local repetitions with disposable fake providers.
- No waiting/retry UI is ever rendered in that successful case.
- All 17 fake provider processes are running within 10 seconds.
- During 32 concurrent reconcile requests, `/api/health` and an unrelated
  WebSocket round trip remain below 250 ms p95.
- One request performs at most one provider batch and one lookup per unique
  provider/session/cwd tuple.
- At most four blocking exact batches run globally. Overload returns a
  retryable verdict; Tokio’s unbounded blocking queue is never used as the
  admission queue.
- 201 and 417 panes are sent as deterministic wire batches of at most 200.
  Every create remains held until that pane’s own current-generation verdict.
- A miss, partial read, metadata error, SQLite busy/schema error, stale row,
  ambiguous match, or provider-store race never authorizes a process.
- A restore create whose current proof no longer establishes the same exact
  owner between reconcile and launch does not spawn.
- A provider that reports a different session identity after launch is treated
  as a failed restore, not silently adopted.
- Simultaneous terminal-versus-fresh, WS-versus-REST, and auto-resume races for
  one provider/session produce one owner and at most one process/logical
  writer.
- A new client trusts actionable durable reconciliation only when
  `ready.capabilities.paneReconcileExactV1` is acknowledged. Against an older
  server it sends zero durable creates and shows “Server update required to
  restore saved sessions.” Stateless panes still start.
- The broad History scan can remain blocked for the whole successful restore.
- Port 3002 is neither restarted nor deployed during implementation.

---

## Load-Bearing Decisions Already Validated

These corrections are requirements, not optional refinements:

1. **Positive-only exact authority.** A 20,000-lookup atomic-rename experiment
   produced 1,069 false Claude misses, including 44 consecutive double misses,
   while the transcript always existed. Neither two scans nor a “fresh”
   `SessionIndex` is a safe absence fence. Therefore exact reconciliation never
   emits `Absent`; unresolved evidence stays unresolved.
2. **History is listing-only here.** A cached History positive remained after
   its transcript was deleted. History may populate the sidebar and advisory
   observation history, but may not authorize or reject an exact restore.
3. **Request-local facts only.** There is no persistent exact-result cache, so
   create/delete/rename/root invalidation cannot latch between requests.
4. **Provider set is closed.** Claude, Codex, OpenCode, and Amplifier have
   provider-specific resume contracts. Gemini, Kimi, and arbitrary extensions
   currently accept structured references despite lacking a reliable resume
   contract; they must be rejected as durable recovery providers before any
   store I/O.
5. **Provider roots are independent of History and `HOME`.** Exact probing is
   constructed even when the History index is unavailable. Each provider
   resolves the same effective roots its launched CLI uses.
6. **SQLite read-only means no logical database writes.** Freshell opens
   OpenCode/Codex with SQLite read-only flags and never migrates, checkpoints,
   or read-repairs. SQLite’s standard WAL coordination may create/update
   `-shm`; tests require the database and WAL contents to remain unchanged.
   This is already the behavior of Freshell’s existing OpenCode History reader.
7. **Codex’s database is an accelerator, not truth.** On the observed store,
   4,364 of 8,502 rows referenced missing files and 23 rollout files had no
   row. Use the native DB-first path, verify its rollout, then fall back to
   active/archive plain/zstd search. Do not read-repair Codex’s database.
8. **Amplifier identity is cwd-scoped.** The provider resumes through the
   current project store and tolerates some partial legacy directories. Exact
   lookup uses the pane’s expected cwd/project slug; global first-match scans
   are forbidden. The existing idempotent, lease-protected restub rule remains
   the one provider-specific miss exception.
9. **Zero-turn allocation is not loss.** Claude allocates a UUID before the
   transcript exists. Persist whether the server allocated an
   unmaterialized identity. On restart, that state may relaunch the same
   `--session-id`; a legacy/previously-materialized missing identity may not.
10. **One controller owns client reconciliation.** App boot, retry banner,
    views, and reconnect may not independently fold results for the same pane.
11. **One owner spans pane kinds and launch surfaces.** The existing terminal
    and fresh-agent lease maps are separate and their cross-liveness checks are
    non-atomic. Keep them as defense in depth, but arbitrate every restore
    through one server-wide `(provider, sessionId)` owner before provider
    setup.
12. **Initial identity is not a rebind.** The first provider identity signal
    for a restore must match the expected reference and launch nonce.
    Only after that match may later authenticated terminal signals enter the
    ordinary in-pane rebind path.

Residual provider behavior that cannot be proved without mutating a real store
must fail closed and is covered by disposable fake-provider contracts.

---

## Internal Recovery Contract

Add an internal typed result; do not widen the frozen wire verdict enum:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExactRecoveryState {
    Present(ExactRecoveryProof),
    AllocatedUnmaterialized, // provider-specific and ledger-proved
    Retryable(ExactRecoveryIssue),
    ProviderUnavailable,
    Conflict,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExactRecoveryProof {
    /// Provider-defined ownership fingerprint. Replacement by another
    /// independently verified artifact for the same exact owner is allowed;
    /// wrong-owner, partial, or unverifiable replacement is not.
    pub owner_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ExactRecoveryQuery {
    pub session_ref: SessionLocator,
    pub cwd: Option<PathBuf>,
    pub materialization: MaterializationState,
}
```

`Retryable` maps to wire `error` with
`reason:"session_check_pending"`. `ProviderUnavailable`, `Conflict`, and
`Invalid` map to terminal, non-auto-retrying reasons. No exact-provider path
returns `SessionExistence::Absent`.

The request-local snapshot answers only the exact keys it contains. If final
registry/ledger re-derivation selects a different reference or cwd, a missing
snapshot fact maps to retry. That is the state-race fence.

---

## File Map

### Shared recovery contract and server composition

- New: `crates/freshell-recovery/Cargo.toml`
- New: `crates/freshell-recovery/src/lib.rs`
- New: `crates/freshell-recovery/src/coordinator.rs`
- New: `crates/freshell-recovery/src/ownership.rs`
- `Cargo.toml`
- `Cargo.lock`
- `crates/freshell-ws/src/existence.rs`
- `crates/freshell-ws/src/reconcile.rs`
- `crates/freshell-ws/src/reconcile_freshagent.rs`
- `crates/freshell-ws/src/terminal.rs`
- `crates/freshell-ws/src/lib.rs`
- `crates/freshell-server/src/existence.rs`
- `crates/freshell-server/src/main.rs`
- New: `crates/freshell-server/src/recovery_providers.rs`
- `crates/freshell-ws/src/pane_ledger.rs`
- `crates/freshell-ws/src/pane_ledger_tests.rs`
- `crates/freshell-terminal/src/registry.rs`
- `crates/freshell-freshagent/src/lib.rs`
- `crates/freshell-freshagent/src/session_lease.rs`
- `shared/ws-protocol.ts`
- `crates/freshell-protocol/src/client_messages.rs`
- `crates/freshell-protocol/src/server_messages.rs`

### Provider proofs

- `crates/freshell-freshagent/src/claude_snapshot.rs`
- `crates/freshell-freshagent/src/claude.rs`
- `crates/freshell-freshagent/src/codex.rs`
- `crates/freshell-freshagent/src/opencode_ws.rs`
- `crates/freshell-freshagent/src/terminal_tabs.rs`
- `crates/freshell-freshagent/src/lib.rs`
- New: `crates/freshell-sessions/src/codex_exact.rs`
- `crates/freshell-sessions/src/parse/opencode.rs`
- `crates/freshell-sessions/src/amplifier_stub.rs`
- `crates/freshell-sessions/src/lib.rs`
- `crates/freshell-ws/src/auto_resume.rs`
- `crates/freshell-ws/src/claude_signal.rs`
- `crates/freshell-ws/src/opencode_signal.rs`
- `crates/freshell-ws/src/opencode_association.rs`
- `crates/freshell-ws/src/codex_association.rs`
- `crates/freshell-platform/src/cli_launch.rs`
- `crates/freshell-terminal/src/registry.rs`
- `crates/freshell-codex/src/launch_lifecycle.rs`
- `crates/freshell-codex/src/remote_proxy.rs`
- `Cargo.toml`
- `Cargo.lock`
- `crates/freshell-sessions/Cargo.toml`

### Client controller and UX

- New: `src/lib/pane-reconcile-controller.ts`
- `src/lib/pane-reconcile.ts`
- `src/lib/ws-client.ts`
- `src/App.tsx`
- `src/components/TerminalView.tsx`
- `src/components/fresh-agent/FreshAgentView.tsx`
- `src/components/ReconcileWarmingBanner.tsx`
- `src/store/paneTypes.ts`
- `src/store/panesSlice.ts`

### Tests

- `crates/freshell-server/src/existence.rs` tests
- `crates/freshell-recovery/src/coordinator.rs` tests
- `crates/freshell-recovery/src/ownership.rs` tests
- `crates/freshell-ws/tests/pane_reconcile.rs`
- `crates/freshell-ws/tests/pane_reconcile_freshagent.rs`
- `crates/freshell-ws/tests/session_ref_singleflight.rs`
- `crates/freshell-ws/tests/cross_kind_liveness.rs`
- New: `crates/freshell-sessions/tests/codex_exact.rs`
- New: `crates/freshell-sessions/tests/opencode_exact.rs`
- `test/unit/client/lib/pane-reconcile.test.ts`
- New: `test/unit/client/lib/pane-reconcile-controller.test.ts`
- `test/unit/client/lib/ws-client.reconcile.test.ts`
- `test/unit/client/components/App.reconcile-adoption.test.tsx`
- `test/unit/client/components/DeadSessionPanel.test.tsx`
- `test/e2e-browser/specs/reconcile-handshake-rust.spec.ts`
- `test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts`

---

### Task 1: Establish the Shared Recovery Contract and Close the Provider Boundary

**Files:**
- Add `crates/freshell-recovery/Cargo.toml`
- Add `crates/freshell-recovery/src/lib.rs`
- Add `crates/freshell-recovery/src/coordinator.rs`
- Add `crates/freshell-recovery/src/ownership.rs`
- Modify workspace `Cargo.toml` and `Cargo.lock`
- Modify `crates/freshell-ws/src/existence.rs`
- Modify `crates/freshell-ws/src/reconcile.rs`
- Modify `crates/freshell-ws/src/pane_ledger.rs`
- Modify `crates/freshell-ws/src/pane_ledger_tests.rs`
- Add `crates/freshell-server/src/recovery_providers.rs`
- Modify `crates/freshell-server/src/main.rs`
- Modify `shared/ws-protocol.ts`
- Modify `crates/freshell-protocol/src/client_messages.rs`
- Modify `crates/freshell-protocol/src/server_messages.rs`
- Modify focused protocol/reconcile tests

**Interfaces:**
- `RecoveryProviderRegistry`
- `ExactRecoveryQuery`, `ExactRecoveryState`, `ExactRecoveryIssue`
- `ExactRecoveryProof`
- `MaterializationState::{Allocated, Observed, Unknown}`
- provider-aware `validate_session_ref(mode, session_ref)`
- additive negotiated capability `paneReconcileExactV1`

- [ ] **Step 1: Write RED tests for the closed boundary**

Cover terminal and fresh-agent panes:

- unknown/custom/Gemini/Kimi structured refs return
  `invalid{unsupported_session_provider}`;
- provider/mode mismatch is invalid;
- malformed/traversal/oversized IDs return invalid;
- an instrumented registry records zero root/filesystem/SQLite calls for every
  invalid case;
- valid IDs are:
  - canonical hyphenated UUID for Claude and Codex;
  - bounded `ses_` OpenCode identifier;
  - bounded, non-whitespace, single path-component Amplifier identifier
    (do not impose UUID-only; most real Amplifier IDs contain underscores).

Run:

```bash
cargo test -p freshell-ws --test pane_reconcile invalid_session_refs_do_zero_store_io -- --nocapture
cargo test -p freshell-ws --test pane_reconcile_freshagent invalid_session_refs_do_zero_store_io -- --nocapture
```

Expected RED: unknown providers currently become absent/fresh and validation is
not provider-aware.

- [ ] **Step 2: Implement the leaf contract crate, typed registry, and validation**

Put the I/O-free query/result types, coordinator interface, and ownership
interface in `freshell-recovery`, depending only on lower-level protocol/value
crates. Both `freshell-ws` and `freshell-freshagent` depend on this leaf; the
leaf must not depend on either, preventing a cycle. The server composition
root owns the concrete provider registry and injects the same shared
coordinator/owner into WebSocket, REST, auto-resume, and fresh-agent state.

Make the registry the only route from a durable `SessionLocator` to store I/O.
Keep shell and non-resumable extension panes on their existing fresh behavior;
they may not claim durable recovery.

- [ ] **Step 3: Write RED additive wire-capability tests**

Pin protocol parsing/serialization for offered, acknowledged, and omitted
`paneReconcileExactV1`. A server may echo it only when the client offered it
and the exact coordinator is configured; otherwise it is omitted while legacy
`paneReconcileV1` remains unchanged. The capability is additive. Do not change
the request/result discriminants, the 200-pane limit, or the frozen verdict
enum.

The client behavior and real four-cell old/new matrix are implemented in
Tasks 6 and 7, after both sides exist.

Run:

```bash
cargo test -p freshell-protocol --test pane_reconcile -- --nocapture
cargo test -p freshell-ws capability_negotiation -- --nocapture
```

- [ ] **Step 4: Write RED ledger tests for allocated versus observed**

Pin additive JSON compatibility:

- a new Claude preallocation persists `Allocated`;
- a provider ownership proof advances it monotonically to `Observed`;
- `Observed` never regresses to `Allocated`;
- old ledger JSON without the field loads as `Unknown`;
- locked/disabled ledger yields `Unknown`, never fabricated observation.

Run:

```bash
cargo test -p freshell-ws pane_ledger -- --nocapture
```

- [ ] **Step 5: Implement materialization persistence**

Add `materialization` to `BindingWrite`/ledger rows and a durable
`mark_materialized(provider, session_id)` operation using the ledger’s existing
atomic write discipline. Claude preallocation writes `Allocated`; exact
provider positives and authoritative association write `Observed`.

- [ ] **Step 6: Add independent provider-root construction tests**

With `HOME` absent, construct the registry with only one provider override at a
time. Exact-provider registration must not depend on `SessionIndex` or
`provider_home()`.

- [ ] **Step 7: Run focused checks and commit**

```bash
cargo test -p freshell-ws pane_ledger -- --nocapture
cargo test -p freshell-ws --test pane_reconcile -- --nocapture
cargo test -p freshell-server recovery_providers -- --nocapture
cargo test -p freshell-protocol --test pane_reconcile -- --nocapture
cargo fmt --check
git diff --check
git add Cargo.toml Cargo.lock crates/freshell-recovery crates/freshell-protocol \
  crates/freshell-ws crates/freshell-server shared/ws-protocol.ts
git commit -m "feat(recovery): close durable provider and materialization contracts"
```

---

### Task 2: Ownership-Proved Claude and Codex Batch Lookups

**Files:**
- Modify `crates/freshell-freshagent/src/claude_snapshot.rs`
- Modify `crates/freshell-freshagent/src/claude.rs`
- Modify `crates/freshell-freshagent/src/lib.rs`
- Modify `crates/freshell-platform/src/cli_launch.rs`
- Add `crates/freshell-sessions/src/codex_exact.rs`
- Add `crates/freshell-sessions/tests/codex_exact.rs`
- Modify `crates/freshell-sessions/src/lib.rs`
- Modify workspace/crate Cargo files for `toml` and `zstd`
- Modify `crates/freshell-server/src/recovery_providers.rs`

**Claude contract:**

- Resolve the child-effective transcript root:
  `CLAUDE_CONFIG_DIR`, otherwise the compatibility `CLAUDE_HOME`, otherwise
  `HOME/.claude`. When compatibility `CLAUDE_HOME` wins, inject the same path
  as `CLAUDE_CONFIG_DIR` into the launched Claude environment so reader and
  writer agree.
- Use expected cwd/project information when available.
- Support the validated current main layout
  `projects/<project-slug>/<canonical-uuid>.jsonl`.
- Reject subagent paths as main-session ownership.
- Open the candidate once, read bounded JSONL records from that same handle,
  and require matching embedded `sessionId`.
- An empty/partial record, incomplete enumeration, or changed file identity is
  retryable. Multiple distinct main artifacts are conflict.
- No hit is retryable, except ledger-proved `Allocated`, which returns
  `AllocatedUnmaterialized`.

**Codex contract:**

- Resolve rollout root from `CODEX_HOME`/config and SQLite root independently
  from `CODEX_SQLITE_HOME`/`sqlite_home`.
- Require a canonical thread UUID before I/O.
- Open `state_5.sqlite` read-only/WAL-aware and validate the expected schema.
  Query `threads.id` as the fast candidate, but never trust the row alone.
- Verify the referenced file’s owned session metadata using Codex’s native
  permitted-leading-record rule, for both plain JSONL and zstd.
- Fall back to both `sessions/` and `archived_sessions/`.
- A valid DB-selected owned path is canonical. Without a valid DB selection,
  one unique owned fallback wins; multiple distinct owned fallbacks conflict.
- Stale row, missing row/file, empty/partial metadata, busy/corrupt/unknown
  schema, or incomplete scan is retryable. Never migrate, checkpoint, or
  read-repair.

- [ ] **Step 1: Pin Claude behavior with RED tests**

Test valid direct transcript, subagent-only match, allocated/no-file, partial
metadata, provider/mode mismatch, expected-cwd direct lookup despite an
unrelated project error, no-cwd enumeration error as retryable, changed inode
during read, multiple configured roots (only the child-effective winner is
visible; lower-precedence roots are ignored), and conflicting distinct hits
within that effective root.
Launch goldens cover terminal and fresh Claude with compatibility-only
`CLAUDE_HOME`: both child environments receive the selected path as
`CLAUDE_CONFIG_DIR`, while an explicit `CLAUDE_CONFIG_DIR` still wins.

```bash
cargo test -p freshell-freshagent claude_snapshot -- --nocapture
cargo test -p freshell-platform cli_launch -- --nocapture
```

- [ ] **Step 2: Implement and refactor Claude**

Keep the legacy `locate_transcript` wrapper behavior for non-recovery callers.
The new batch API returns typed evidence and never collapses a checked error to
absence.

- [ ] **Step 3: Pin Codex native-store behavior with RED tests**

Fixtures cover:

- valid DB-selected active plain rollout;
- archived rollout;
- zstd rollout;
- leading records before `session_meta`;
- stale DB row followed by unique fallback;
- rollout missing from DB;
- unknown schema/version;
- WAL-visible committed row;
- SQLite busy;
- partial/oversized metadata;
- canonical duplicate without a DB selection;
- DB and rollout roots split by configuration;
- database and WAL hashes unchanged by repeated lookup (SHM coordination is
  allowed).

```bash
cargo test -p freshell-sessions --test codex_exact -- --nocapture
```

- [ ] **Step 4: Implement Codex DB-first verified fallback**

Use bounded decompression and bounded metadata reading. Batch all requested
UUIDs in one connection/tree walk and deduplicate repeated queries.

- [ ] **Step 5: Run provider tests and commit**

```bash
cargo test -p freshell-freshagent claude_snapshot -- --nocapture
cargo test -p freshell-platform cli_launch -- --nocapture
cargo test -p freshell-sessions --test codex_exact -- --nocapture
cargo test -p freshell-sessions codex -- --nocapture
cargo fmt --check
git diff --check
git add Cargo.toml Cargo.lock crates/freshell-freshagent \
  crates/freshell-platform crates/freshell-sessions \
  crates/freshell-server/src/recovery_providers.rs
git commit -m "feat(recovery): prove exact claude and codex sessions"
```

---

### Task 3: Exact OpenCode and Cwd-Scoped Amplifier Proofs

**Files:**
- Modify `crates/freshell-sessions/src/parse/opencode.rs`
- Add `crates/freshell-sessions/tests/opencode_exact.rs`
- Modify `crates/freshell-sessions/src/amplifier_stub.rs`
- Modify `crates/freshell-freshagent/src/opencode_ws.rs`
- Modify `crates/freshell-server/src/recovery_providers.rs`

**OpenCode contract:**

- Match the installed provider’s effective DB path:
  absolute/relative `OPENCODE_DB`, data-home resolution, and channel-specific
  filenames.
- Validate the supported `session` schema and exact primary-key index.
- Query all requested IDs in one read-only WAL-aware connection/transaction.
- Root, child, and archived rows are valid exact identities.
- DB replacement/inode change, busy, unknown schema, or no row is retryable.
- Do not modify DB/WAL contents or run provider migrations. Standard SQLite
  SHM coordination is allowed and documented.

**Amplifier contract:**

- Resolve the same home and cwd slug used by `ensure_session` and launch.
- With expected cwd, inspect only
  `projects/<cwd-slug>/sessions/<session-id>`.
- A provider-compatible exact directory is present; contradictory
  `metadata.session_id` is retryable/conflict rather than silently adopted.
- Without expected cwd, enumerate all candidates and require a unique
  provider-compatible owner; no first-entry selection.
- Missing directories keep the existing
  lease-protected `AllocatedUnmaterialized`/restub behavior.
- Extraction must not accidentally change tolerant `ensure_session`
  behavior, symlink policy, divergent-slug cwd handling, or concurrent
  idempotence.

- [ ] **Step 1: Write RED OpenCode path/schema/WAL tests**

```bash
cargo test -p freshell-sessions --test opencode_exact -- --nocapture
```

Include `OPENCODE_DB` absolute/relative, default/channel files, HOME-unset XDG,
PK query plan, root/child/archive, live WAL row, busy, schema mismatch,
replacement during query, miss-as-retry, and before/after DB/WAL hashes.

- [ ] **Step 2: Implement the OpenCode batch query**

Extract one canonical effective-database resolver and reuse it from History,
association, exact recovery, and launch environment construction.

- [ ] **Step 3: Pin Amplifier compatibility and ambiguity RED tests**

```bash
cargo test -p freshell-sessions amplifier_stub -- --nocapture
```

Cover expected-cwd valid/partial/mismatched metadata, divergent slug, duplicate
global IDs, unreadable unrelated sibling, project symlink behavior, traversal,
missing stub, two concurrent restubs, and old/new `ensure_session` parity.

- [ ] **Step 4: Implement the shared cwd-scoped lookup**

Separate the typed recovery adapter from the compatibility adapter used by
`ensure_session`; share traversal primitives, not incompatible error policies.

- [ ] **Step 5: Run focused tests and commit**

```bash
cargo test -p freshell-sessions --test opencode_exact -- --nocapture
cargo test -p freshell-sessions amplifier_stub -- --nocapture
cargo test -p freshell-freshagent opencode -- --nocapture
cargo test -p freshell-server recovery_providers -- --nocapture
cargo fmt --check
git diff --check
git add crates/freshell-sessions crates/freshell-freshagent/src/opencode_ws.rs \
  crates/freshell-server/src/recovery_providers.rs
git commit -m "feat(recovery): prove opencode and amplifier recovery identities"
```

---

### Task 4: Bounded Request-Local Reconciliation and One Cross-Kind Owner

**Files:**
- Modify `crates/freshell-recovery/src/coordinator.rs`
- Modify `crates/freshell-recovery/src/ownership.rs`
- Modify `crates/freshell-ws/src/existence.rs`
- Modify `crates/freshell-ws/src/reconcile.rs`
- Modify `crates/freshell-ws/src/reconcile_freshagent.rs`
- Modify `crates/freshell-ws/src/terminal.rs`
- Modify `crates/freshell-ws/src/auto_resume.rs`
- Modify `crates/freshell-ws/src/lib.rs`
- Modify `crates/freshell-freshagent/src/lib.rs`
- Modify `crates/freshell-freshagent/src/session_lease.rs`
- Modify `crates/freshell-freshagent/src/claude.rs`
- Modify `crates/freshell-freshagent/src/codex.rs`
- Modify `crates/freshell-freshagent/src/opencode_ws.rs`
- Modify `crates/freshell-freshagent/src/terminal_tabs.rs`
- Modify `crates/freshell-freshagent/src/pane_ops.rs`
- Modify `crates/freshell-terminal/src/registry.rs`
- Modify `crates/freshell-server/src/existence.rs`
- Modify `crates/freshell-server/src/main.rs`
- Modify Rust reconcile, ownership, and cross-kind tests

**Interfaces:**

```rust
pub trait BlockingExactRecoveryProbe: Send + Sync {
    /// Called only inside the coordinator's admitted blocking job.
    fn lookup_many_blocking(
        &self,
        queries: &[ExactRecoveryQuery],
    ) -> ExactRecoverySnapshot;
}

impl RecoveryCoordinator {
    pub async fn reconcile_many(/* ... */) -> ExactRecoverySnapshot;
    pub async fn revalidate_for_launch(/* ... */) -> ExactRecoveryState;
}
```

Store probes are deliberately synchronous, but only the coordinator may call
them. Async request/launch code receives the coordinator’s async API so no
call site can accidentally perform filesystem or SQLite work on a Tokio
worker.

- The server composition root constructs one `Arc<RecoveryCoordinator>` and
  one `Arc<SessionOwnerArbiter>`, then injects those exact instances into
  WebSocket, REST, auto-resume, and every fresh-agent provider state. Existing
  terminal and fresh-agent lease maps remain defense in depth, not competing
  authorities.
- The handler validates before deriving roots or touching a store, then
  collects every plausible final server/client/ledger reference: structured
  client ref, promoted mode plus `resumeSessionId`, terminal identity row,
  terminal registry row, ledger supersession terminus, fresh-agent session
  state, and expected cwd.
- It deduplicates queries, acquires one owned permit from a four-permit
  semaphore before `spawn_blocking`, and moves the permit into the blocking
  closure. `try_acquire_owned` overload produces retry immediately; it never
  queues an unbounded blocking task.
- A bounded response timeout may return retry while the admitted blocking job
  continues holding its permit until exit.
- Final derivation rereads registry, identity, and ledger. A selected query
  absent from the request-local snapshot is retry.
- `Present` yields respawn; `AllocatedUnmaterialized` yields only the
  provider-specific same-ID launch path; every miss/error yields
  `error{session_check_pending}`.
- Fresh-agent retry does not burn its respawn cap.
- History snapshots and `ever_observed` cannot turn unresolved exact evidence
  into present/absent/fresh/dead.
- The arbiter key is the normalized `(provider, sessionId)`, independent of
  pane kind and transport. A claim has an opaque attempt ID and launch nonce;
  only that token may renew, bind, begin cleanup, or release it.
- Claims do not become stealable merely because a timer elapsed. A claimant
  renews while queued, setting up, and awaiting provider acknowledgement.
  Failed claims remain owned through process/logical-writer cleanup; release
  happens only after cleanup is confirmed. Bound ownership ends only on an
  authoritative process/session lifecycle event.
- Add structured logs for admission, exact verdict, owner claim/contention,
  renewal, binding, cleanup, and release. Log provider and opaque IDs/reasons,
  never transcript content.

- [ ] **Step 1: Write RED pure verdict and History-independence tests**

Cover terminal and fresh-agent:

- exact present with History cold/warm/stale/negative;
- exact miss/error with cached History positive;
- miss/error never fresh/dead/respawn;
- allocated Claude and Amplifier special paths;
- fresh-agent retry does not increment the respawn counter;
- unsupported/permanent/conflict reasons.

```bash
cargo test -p freshell-ws reconcile -- --nocapture
cargo test -p freshell-ws --test pane_reconcile_freshagent -- --nocapture
```

- [ ] **Step 2: Write RED validation, batch-admission, and final-authority tests**

Use barriers/counters for 1/17/50/200 queries, repeated IDs, 32 concurrent
requests, registry live-terminal creation, ledger A→B supersession, cwd change,
provider artifact replace, and dropped socket.

Assertions:

- malformed/unsupported references in every authoritative carrier listed
  above cause zero root/filesystem/SQLite calls;
- one batch/provider/request and one unique lookup;
- max four blocking jobs;
- overload retry;
- event loop remains responsive;
- final A→B without a B fact retries;
- live terminal appearing while the batch runs attaches;
- a same-owner artifact replacement is actionable only after the replacement
  is independently verified and produces a current proof; and
- wrong-owner, partial, missing, and conflicting replacements never authorize.

```bash
cargo test -p freshell-ws --test pane_reconcile exact_batches -- --nocapture
cargo test -p freshell-ws --test pane_reconcile invalid_authority_carriers -- --nocapture
```

- [ ] **Step 3: Implement request-local exact gathering**

Remove the blind two-second sleep. Preserve the 200-entry per-frame cap and
unchanged request/result JSON vocabulary. Advertise
`paneReconcileExactV1` only when this exact coordinator is installed and the
client offered it. Legacy `paneReconcileV1` still negotiates for old clients
but is not sufficient authority for a new client to release a durable create.

- [ ] **Step 4: Write RED cross-kind ownership tests**

Use a common barrier to race claims for the same Claude, Codex, and OpenCode
identity:

- terminal versus fresh-agent;
- WebSocket terminal versus REST terminal;
- explicit create versus server auto-resume; and
- two different panes/connections of the same kind.

Assert exactly one claim wins, losers get the existing attach/conflict
semantics, and no test observes two setup entries, processes, or logical
writers. Separately test owner renewal beyond the old 20-second lease window,
attempt-token fencing, release refusal before confirmed cleanup, and binding
release on authoritative exit.

```bash
cargo test -p freshell-recovery ownership -- --nocapture
scripts/sandbox-test.sh "cargo test -p freshell-ws --test session_ref_singleflight -- --nocapture"
cargo test -p freshell-ws --test cross_kind_liveness -- --nocapture
```

- [ ] **Step 5: Implement and inject the shared arbiter**

Implement one state machine in `freshell-recovery`; do not try to coordinate
two pre-existing maps with check-then-act calls. Inject the same `Arc` at the
server root. Add the claim API to all launch states now; Task 5 places the
full provider-specific launch transaction behind it.

- [ ] **Step 6: Run focused checks and commit**

```bash
cargo test -p freshell-recovery -- --nocapture
cargo test -p freshell-ws reconcile -- --nocapture
cargo test -p freshell-ws --test pane_reconcile -- --nocapture
cargo test -p freshell-ws --test pane_reconcile_freshagent -- --nocapture
scripts/sandbox-test.sh "cargo test -p freshell-ws --test session_ref_singleflight -- --nocapture"
cargo test -p freshell-ws --test cross_kind_liveness -- --nocapture
cargo test -p freshell-server existence -- --nocapture
cargo fmt --check
git diff --check
git add crates/freshell-recovery crates/freshell-ws crates/freshell-freshagent \
  crates/freshell-terminal crates/freshell-server
git commit -m "fix(recovery): reconcile exact sessions off thread without guessing"
```

---

### Task 5: Fence Every Restore Launch with Current Proof and Initial Identity

**Files:**
- Modify `crates/freshell-recovery/src/ownership.rs`
- Modify `crates/freshell-ws/src/terminal.rs`
- Modify `crates/freshell-ws/src/auto_resume.rs`
- Modify `crates/freshell-ws/src/claude_signal.rs`
- Modify `crates/freshell-ws/src/opencode_signal.rs`
- Modify `crates/freshell-ws/src/opencode_association.rs`
- Modify `crates/freshell-ws/src/codex_association.rs`
- Modify `crates/freshell-platform/src/cli_launch.rs`
- Modify `crates/freshell-terminal/src/registry.rs`
- Modify `crates/freshell-codex/src/launch_lifecycle.rs`
- Modify `crates/freshell-codex/src/remote_proxy.rs`
- Modify `crates/freshell-freshagent/src/lib.rs`
- Modify `crates/freshell-freshagent/src/claude.rs`
- Modify `crates/freshell-freshagent/src/codex.rs`
- Modify `crates/freshell-freshagent/src/opencode_ws.rs`
- Modify `crates/freshell-freshagent/src/terminal_tabs.rs`
- Modify `crates/freshell-freshagent/src/pane_ops.rs`
- Modify provider launch and lifecycle tests

**Launch transaction:**

Every restore/resume entry point follows one order:

1. acquire the existing shared spawn permit;
2. claim the global cross-kind `(provider, sessionId)` owner;
3. derive the final session reference, cwd, and materialization state;
4. revalidate exact provider proof through the bounded coordinator;
5. perform provider setup and launch;
6. await the first authoritative identity acknowledgement carrying this
   launch nonce;
7. atomically bind the global owner and persist the observed identity; then
8. answer the client and release the spawn permit.

Ownership remains held through step 7. On proof change, timeout, revocation,
identity mismatch, or launch failure, terminate and confirm the owned process
tree before releasing the owner. OpenCode’s shared sidecar is the explicit
exception: discard the failed logical session attempt and its routes without
killing unrelated sessions in the shared process.

The order applies to every launch door, whether or not the client negotiated a
reconcile capability:

- WebSocket `terminal.create` with structured or promoted session identity;
- REST terminal create, split, and respawn;
- server terminal auto-resume;
- fresh-agent create for Claude, Codex, and OpenCode;
- fresh-agent attach of an untracked/crashed durable session;
- lazy fresh-Codex crash recovery; and
- fresh-OpenCode send when it materializes/starts a durable logical session.

Amplifier has no fresh-agent runtime. A fresh-agent Amplifier durable
reference is invalid before I/O.

No provider setup may precede step 4. In particular, failed proof must happen
before Amplifier `ensure_session`/restub, managed Codex app-server or proxy
planning/`ensure_ready`, OpenCode manager startup/config/MCP writes, or PTY
spawn.

**Provider acknowledgement contract:**

- terminal Claude: register expected ID plus nonce before spawn; the first
  owned `SessionStart` hook must match. Only later authenticated hooks may
  perform an ordinary in-pane rebind;
- fresh Claude: the first `sdk.session.init.cliSessionId` must match before
  the claim settles;
- terminal Codex: exact restore uses an authoritative managed path whose
  `ThreadStarted` is consumed and matched before settlement. A later lineage
  fork may rebind only after the initial match;
- fresh Codex: keep the existing authoritative thread/resume response check
  and bring attach/crash recovery under the same owner transaction;
- terminal OpenCode: install a mandatory nonce-bound restore reporter before
  launch. If the provider configuration cannot guarantee it, fail closed;
  only later authenticated route signals may rebind;
- fresh OpenCode: `GET /session/{requested}` must return an object whose
  embedded `id` exactly matches; checking only that it is an object is not
  sufficient; and
- terminal Amplifier: bounded startup output must contain the exact
  `Resuming session: <resolved-id>` acknowledgement. Amplifier has no
  supported later in-pane rebind.

- [ ] **Step 1: Write RED launch-door and zero-side-effect tests**

Create a table-driven harness for every launch door above. Mutate the final
identity carrier while queued: structured ref, promoted mode/ref, terminal
identity, registry identity, ledger supersession terminus, and cwd. Delete,
replace, partially rewrite, or conflict the provider artifact after reconcile
but before launch.

Assert a newly selected invalid/unproved reference causes zero provider-store
and setup calls; failed proof causes no restub, app-server/proxy, OpenCode
manager/config write, PTY, or fresh runtime; retryable fresh outcomes do not
burn the respawn cap.

- [ ] **Step 2: Write RED provider acknowledgement tests**

For each supported terminal/fresh provider, cover matching first identity,
mismatch, missing acknowledgement timeout, stale nonce, duplicate signal, and
a later authenticated rebind where supported. Assert that mismatch/timeout
never persists or adopts the reported identity.

```bash
cargo test -p freshell-ws launch_lifecycle -- --nocapture
cargo test -p freshell-freshagent restore_identity -- --nocapture
```

- [ ] **Step 3: Write RED cleanup and long-launch ownership tests**

Use controlled child processes and barriers at queue, proof, setup, spawned,
and acknowledgement phases. Hold each phase beyond the former 20-second lease
window and race a second claimant. Assert no auto-steal and at most one
process/logical writer. For each failure phase, assert cleanup completes before
another owner is admitted. Exercise process-tree cleanup in the destructive
sandbox; prove the OpenCode shared-sidecar exception removes only the failed
logical route.

```bash
scripts/sandbox-test.sh "cargo test -p freshell-ws launch_owner_lifecycle -- --nocapture"
cargo test -p freshell-freshagent launch_owner_lifecycle -- --nocapture
```

- [ ] **Step 4: Implement the common launch transaction**

Factor one guard/state machine that owns permit, claim token, renewal task,
proof, nonce, acknowledgement channel, and cleanup transition. Provider
adapters supply setup/spawn/ack/cleanup operations; they may not reorder the
transaction. Use the same exact verdict mapping for terminal and fresh-agent
paths so `Unknown`/`Allocated`/`Observed` cannot drift.

- [ ] **Step 5: Implement provider-specific nonce-bound acknowledgements**

Register the expected identity before spawning or exposing a runtime. Remove
the current behavior that treats a different first identity as an ordinary
rebind. Persist `Observed` only after the matching acknowledgement and owner
binding are committed together.

- [ ] **Step 6: Run focused checks and commit**

```bash
cargo test -p freshell-ws launch_lifecycle -- --nocapture
cargo test -p freshell-freshagent restore_identity -- --nocapture
scripts/sandbox-test.sh "cargo test -p freshell-ws --test session_ref_singleflight -- --nocapture"
scripts/sandbox-test.sh "cargo test -p freshell-ws launch_owner_lifecycle -- --nocapture"
cargo test -p freshell-ws --test cross_kind_liveness -- --nocapture
cargo fmt --check
git diff --check
git add crates/freshell-recovery crates/freshell-ws crates/freshell-freshagent \
  crates/freshell-platform crates/freshell-terminal crates/freshell-codex
git commit -m "fix(recovery): fence restore launch identity across every surface"
```

---

### Task 6: One Client Reconcile Controller, Safe Batching, and Automatic Retry

**Files:**
- Add `src/lib/pane-reconcile-controller.ts`
- Modify `src/lib/pane-reconcile.ts`
- Modify `src/lib/ws-client.ts`
- Modify `src/App.tsx`
- Modify `src/components/TerminalView.tsx`
- Modify `src/components/fresh-agent/FreshAgentView.tsx`
- Modify `src/components/ReconcileWarmingBanner.tsx`
- Modify `src/store/paneTypes.ts`
- Modify `src/store/panesSlice.ts`
- Add/modify focused client tests

**Controller contract:**

- One connection generation owns boot, auto retry, manual retry, and reconnect.
- Durable restore authority requires the server to echo
  `paneReconcileExactV1`. If only legacy `paneReconcileV1` is present, hold
  then discard every durable create without sending it and show “Server update
  required to restore saved sessions.” Stateless panes proceed normally.
  “Start new” remains an explicit identity-clearing escape hatch.
- Each pane also owns an episode token within that connection generation.
  Manual Retry supersedes the prior episode immediately, so a late automatic
  or boot result from the same socket cannot fold.
- If App mounts after the socket is already ready, initialize from WsClient's
  current capability/ready snapshot and start the same generation; do not wait
  for another `ready` frame.
- `buildReconcileRequests` returns deterministic chunks of at most 200; it
  never truncates.
- All requested create IDs enter one sender hold before the first chunk sends.
- Each pane records generation, first-seen time, attempt, next retry, and
  terminal/pending state.
- Every request records a fold-time fingerprint: pane key, kind,
  createRequestId, provider/mode, durable reference, cwd, and live handle.
  Store state must still match that fingerprint before a result may fold.
- Current-generation result folds only its own batch. Stale results and
  results for removed/transformed panes do nothing.
- Mixed results immediately release/cancel resolved panes while unresolved
  panes remain held.
- Retry schedule is 250, 500, 1,000, 2,000, 3,000, then 3,000 ms, bounded to a
  ten-second automatic episode. Attempts therefore occur at 250, 750, 1,750,
  3,750, 6,750, and 9,750 ms; the 12,750 ms attempt is never scheduled. A
  separate deadline settles/cancels the episode at ten seconds even if no
  further server frame arrives. Manual Retry starts a new episode immediately.
- The result classifier is table-driven:
  - retryable: `session_check_pending` and legacy `index_warming`;
  - terminal/fail-closed: unsupported provider, provider unavailable,
    conflict, invalid, fresh, dead session, unknown reason, malformed result,
    and cardinality failure;
  - correlated `RECONCILE_UNAVAILABLE` settles safely; the client-generated
    chunks make `RECONCILE_TOO_LARGE` an invariant failure, never a fallback
    that releases creates.
- Pending state does not expire at the old four-second wall clock. TerminalView
  and FreshAgentView stay gated while the controller owns the pane.
- On terminal conflict/unavailable/invalid or retry exhaustion, cancel the
  stale held create rather than flushing it. Show an actionable pane state;
  only explicit Start new may mint/send a fresh create.
- Closing, transforming, or replacing a pane with a different same-kind
  identity synchronously cancels its timer, subscription, held/in-flight/
  pre-ready tracked create, and ignores late results. Tab removal follows the
  same path.
- Reconnect cancels the old generation and starts one new full generation.
- The warming banner is presentational. It never subscribes or owns timers.
- Sender APIs distinguish three operations: retain held, positively release
  after a current verdict, and discard/cancel without sending. A generic
  “clear” operation may not flush unresolved restore creates.
- “Start new” is one atomic controller/reducer operation: cancel the old
  episode and every registry entry for its request ID, mint a different
  createRequestId, clear all terminal/fresh-agent durable identity and live
  handles, and send one identity-free fresh create. No existing reducer that
  deliberately preserves the old request ID may be reused.

- [ ] **Step 1: Write RED request batching tests**

For 201 and 417 panes assert stable chunk order, unique reconcile IDs, full
coverage, no console-error truncation, all create IDs installed in the sender
hold before the first chunk is sent, and out-of-order chunk replies releasing
only their own panes.

```bash
npm run test:vitest -- run test/unit/client/lib/pane-reconcile.test.ts --config config/vitest/vitest.config.ts
```

- [ ] **Step 2: Write RED controller generation/retry tests**

Use fake clocks and fixed IDs. Cover:

- successful first response under 750 ms renders no status;
- the exact retry attempts occur at 250, 750, 1,750, 3,750, 6,750, and
  9,750 ms, with no 12,750 ms attempt, and the independent 10-second deadline
  cancels the unresolved create;
- mixed settled/warming batches;
- App boot + manual retry + reconnect stale-result interleavings;
- already-ready App bootstrap;
- exact-capability absent/legacy-only: zero durable creates, explicit
  server-update UX, stateless creates unaffected;
- boot → manual Retry → late boot result within one connection generation;
- retry exhaustion cancels rather than flushes;
- permanent conflict/unavailable/invalid;
- close, terminal→browser, and fresh-agent→terminal during scheduled and
  in-flight retry;
- terminal→different-terminal and fresh-agent→different-fresh-agent identity
  replacement, tab removal, close while disconnected, and late replies;
- atomic Start new for both pane kinds: old request never sends/replays, new
  request ID differs and carries no saved identity, and late old verdicts do
  nothing;
- controller disposal leaves zero timers/subscriptions.

```bash
npm run test:vitest -- run test/unit/client/lib/pane-reconcile-controller.test.ts --config config/vitest/vitest.config.ts
```

- [ ] **Step 3: Implement the controller and Redux episode state**

Keep pure request/fold helpers in `pane-reconcile.ts`. Move all ownership and
time into the controller. App creates/disposes one controller and forwards
ready/message/layout changes.

- [ ] **Step 4: Write RED sender/view hold tests**

Prove the sender no longer blindly flushes after four seconds, its explicit
release and discard paths cannot be confused, a current controller can
narrow/cancel IDs, an absent controller cannot send a held restore create, and
both pane kinds remain gated until their exact outcome.

```bash
npm run test:vitest -- run \
  test/unit/client/lib/ws-client.reconcile.test.ts \
  test/unit/client/components/App.reconcile-adoption.test.tsx \
  test/unit/client/components/TerminalView.reconcile.test.tsx \
  test/unit/client/components/FreshAgentView.reconcile.test.tsx \
  --config config/vitest/vitest.config.ts
```

- [ ] **Step 5: Implement view and sender changes**

Add accessible copy and controls:

- delayed transient: “Restoring N saved panes…”
- exhausted: “Freshell couldn’t find or read this saved session.”
- old server: “Server update required to restore saved sessions.”
- buttons: “Retry” and “Start new”

Use semantic buttons, labels, and `role="status"` for transient text; reserve
`role="alert"` for the terminal actionable state.

- [ ] **Step 6: Run focused checks and commit**

```bash
npm run test:vitest -- run \
  test/unit/client/lib/pane-reconcile.test.ts \
  test/unit/client/lib/pane-reconcile-controller.test.ts \
  test/unit/client/lib/ws-client.reconcile.test.ts \
  test/unit/client/components/App.reconcile-adoption.test.tsx \
  --config config/vitest/vitest.config.ts
npm run typecheck
npm run lint
git diff --check
git add src test/unit/client
git commit -m "fix(recovery): restore panes through one automatic reconcile controller"
```

---

### Task 7: Causal Cold-History, Compatibility, and Incident-Scale Browser Proof

**Files:**
- Modify `test/e2e-browser/specs/reconcile-handshake-rust.spec.ts`
- Modify `test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts`
- Modify `test/e2e-browser/helpers/rust-server.ts` only if cleanup support is
  shared there
- Add a small Node FIFO-holder fixture under `test/e2e-browser/fixtures/`

- [ ] **Step 1: Add raw-wire provider and scale coverage**

Seed disposable exact stores for Claude, Codex active/archive/zstd, OpenCode,
and Amplifier. Cover HOME-unset provider overrides, terminal/fresh-agent
present/retry/conflict, 17 unique queries, and 201/417 client batching.

Assert first-response verdicts and structured logs; do not click Retry in any
successful restore test.

- [ ] **Step 2: Add a causal, cancellable History gate**

Linux/WSL-only:

1. Boot a healthy scratch server, persist the target panes, record its PID,
   and record the count/offset of `event:"session_index_warm"` in
   `info.logsDir/rust-server.jsonl`.
2. Arm a second-boot `setupHome` callback, then restart the fixture. Prove the
   old PID has exited before the callback is allowed to mutate the fixture
   home.
3. Inside that callback—after old-server death and before new-server
   spawn—create a first-sorted Claude JSONL FIFO in the disposable provider
   project. Start, but do not await, a killable helper child.
4. Spawn the new server and wait for `/api/health`.
5. Await the helper’s `OPENED` IPC message. That message is causal proof that
   the new History reader has opened the FIFO; the old server could not have
   done so.
6. Start one authenticated `/api/session-directory` request and retain the
   same promise. While it remains pending, prove no new
   `session_index_warm` event exists, health and an unrelated authenticated
   WebSocket round trip succeed, every exact pane restores, and no Retry
   control is rendered.
7. In `finally`, tell the helper to close and reap it first. Then await that
   same History request, prove the warm-event count advanced, and stop the
   scratch server.

Preflight `mkfifo`. Implement the helper as a Node child created with
`process.execPath`, an argument array, and IPC—never a shell. It polls
`openSync(path, O_WRONLY | O_NONBLOCK)`; `ENXIO` retries every 10 ms. On
success it reports `OPENED` and holds the descriptor until IPC close,
disconnect, `SIGTERM`, or `SIGINT`. Cleanup is deterministic: request close,
wait at most one second, then `SIGTERM`, then `SIGKILL` if needed, and always
reap the child. An uncancellable timed-out `fs.open` promise is forbidden.

- [ ] **Step 3: Add the 17-pane user-experience test**

Use 17 durable panes and disposable fake providers. Measure:

- exact verdict timing from `ready`;
- whether the transient status ever enters the DOM;
- fake process count and identity;
- health/unrelated WS latency;
- exactly one process/writer per session;
- tab/pane preservation through abrupt scratch-server restart.

- [ ] **Step 4: Add old/new timing compatibility coverage**

Build and cache frozen base artifacts from commit `67519888` once, record their
hashes, and verify those hashes before each compatibility cell so candidate
sources cannot leak into the base bundle. Exercise:

- candidate client + candidate server: exact capability acknowledged and
  successful durable restore;
- candidate client + base server: exact capability absent, zero durable
  creates, explicit server-update UX, stateless pane still starts;
- base client + candidate server: legacy capability/result shape only;
  immediate present restores, while `session_check_pending` becomes the base
  client’s safe restore error and cancels its held create; and
- base client + base server: recorded two-second warming behavior remains the
  frozen control.

Prefer the actual frozen bundles. If a platform makes one mixed bundle
impossible, use a byte-for-byte recorded protocol fixture only for that cell,
state the boundary in the test name, and retain at least one real mixed-bundle
cell in each direction.

- [ ] **Step 5: Run browser verification and commit**

```bash
npm run test:e2e -- --project=rust-chromium test/e2e-browser/specs/reconcile-handshake-rust.spec.ts
npm run test:e2e -- --project=rust-chromium test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts
npm run test:e2e -- --project=rust-chromium --workers=1 --retries=0 --repeat-each=20 \
  test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts \
  -g "17 durable panes restore while History remains blocked"
git diff --check
git add test/e2e-browser
git commit -m "test(recovery): prove fast exact restore while history is blocked"
```

The repeated test records the exact-verdict, health, unrelated-WebSocket, and
process-ready timings for every repetition and requires every exact verdict
to be under 500 ms and every responsiveness probe under 250 ms. This is
stronger than the p95 acceptance threshold and cannot be hidden by retries.

---

## Item 1 Verification Gate

Before declaring Item 1 complete:

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
npm run typecheck
npm run lint

cargo test -p freshell-freshagent claude_snapshot -- --nocapture
cargo test -p freshell-sessions --test codex_exact -- --nocapture
cargo test -p freshell-sessions --test opencode_exact -- --nocapture
cargo test -p freshell-sessions amplifier_stub -- --nocapture
cargo test -p freshell-recovery -- --nocapture
cargo test -p freshell-ws --test pane_reconcile -- --nocapture
cargo test -p freshell-ws --test pane_reconcile_freshagent -- --nocapture
cargo test -p freshell-ws --test cross_kind_liveness -- --nocapture
cargo test -p freshell-ws launch_lifecycle -- --nocapture
cargo test -p freshell-freshagent restore_identity -- --nocapture
scripts/sandbox-test.sh "cargo test -p freshell-ws --test session_ref_singleflight -- --nocapture"
scripts/sandbox-test.sh "cargo test -p freshell-ws launch_owner_lifecycle -- --nocapture"

npm run test:vitest -- run \
  test/unit/client/lib/pane-reconcile.test.ts \
  test/unit/client/lib/pane-reconcile-controller.test.ts \
  test/unit/client/lib/ws-client.reconcile.test.ts \
  test/unit/client/components/App.reconcile-adoption.test.tsx \
  test/unit/client/components/TerminalView.reconcile.test.tsx \
  test/unit/client/components/FreshAgentView.reconcile.test.tsx \
  --config config/vitest/vitest.config.ts

npm run test:e2e -- --project=rust-chromium \
  test/e2e-browser/specs/reconcile-handshake-rust.spec.ts \
  test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts
npm run test:e2e -- --project=rust-chromium --workers=1 --retries=0 \
  --repeat-each=20 \
  test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts \
  -g "17 durable panes restore while History remains blocked"

FRESHELL_TEST_SUMMARY='verify Item 1 exact automatic restart recovery' npm run check
git status --short
git log --oneline 67519888..HEAD
```

Expected:

- every focused and broad check passes;
- no skipped test was introduced;
- provider-owned real stores were not modified by tests;
- no work outside the Item 1 and inherited-baseline commits is present;
- port 3002 remains on its pre-existing process/commit;
- the worktree is clean.
