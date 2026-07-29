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
claim becomes a durable binding. The owner key is provider-defined:
Claude, Codex, and OpenCode are global by provider/session ID; Amplifier also
includes its validated cwd project scope because the same textual ID may name
different project-local sessions. One client-side controller owns boot
reconcile, chunks above the 200-pane wire cap, automatic/manual retry,
reconnect, create holds, and pane removal.

**Tech stack:** Rust 2021 workspace (Tokio, Axum/WebSocket, rusqlite, notify,
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
- One request performs one admitted blocking job, at most one batch call per
  involved provider, and one lookup per unique provider/session/cwd tuple.
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
  one normalized durable owner key produce one owner and at most one
  process/logical writer.
- A new client trusts actionable durable reconciliation only when
  `ready.capabilities.paneReconcileExactV1` is acknowledged. Against an older
  server—whether it advertises only the legacy capability or none—it sends
  zero durable creates and shows “Server update required to restore saved
  sessions.” Stateless panes still start.
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
   The registry stores resolvers for mutable provider configuration: each
   admitted batch and launch revalidation re-resolves it, and the proof
   fingerprints that effective store. Immutable process environment such as
   OpenCode’s DB selection is normalized once at composition and injected
   into both readers and child writers rather than independently re-resolved.
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
    through one server-wide normalized durable owner key before provider
    setup. That key is `(provider, sessionId)` for Claude/Codex/OpenCode and
    adds the validated project scope for cwd-scoped Amplifier; it must neither
    merge two valid Amplifier projects nor split one global provider identity
    because stale panes carry different cwd strings. Amplifier scope is the
    effective provider project-store identity produced by its real slug/path
    resolver—not the raw cwd spelling—so two cwd spellings that address one
    store still contend.
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
    AllocatedUnmaterialized(RecoveryOwnerKey), // provider-specific and ledger-proved
    Retryable(ExactRecoveryIssue),
    ProviderUnavailable,
    Conflict,
    Invalid(ExactRecoveryIssue),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RecoveryOwnerKey {
    pub provider: String,
    pub session_id: String,
    /// `None` for globally scoped providers; the validated project-store
    /// scope for Amplifier.
    pub provider_scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExactRecoveryProof {
    /// Stable owner identity proved by the artifact/row read.
    pub owner_key: RecoveryOwnerKey,
    /// Same-handle/transaction artifact evidence for diagnostics and race
    /// detection, including the effective store/root fingerprint. It may
    /// change when a replacement independently proves the same owner_key.
    pub artifact_fingerprint: String,
    /// Provider-proved launch cwd when identity is project-scoped.
    pub resolved_cwd: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ExactRecoveryQuery {
    pub session_ref: SessionLocator,
    pub cwd: Option<PathBuf>,
    pub materialization: MaterializationState,
}
```

The shared terminal/fresh mapper is exact:

| Internal state | Wire verdict |
|---|---|
| `Present(proof)` | `respawn` with the exact `sessionRef` (or `attach` if final liveness re-derivation finds its current owner) |
| `AllocatedUnmaterialized(owner)` | `respawn` with the same exact `sessionRef` and the provider-specific allocated launch intent |
| `Retryable(_)` | `error{reason:"session_check_pending"}` |
| `ProviderUnavailable` | `error{reason:"provider_unavailable"}` |
| `Conflict` | `error{reason:"session_identity_conflict"}` |
| `Invalid(issue)` | `invalid{reason:<specific stable issue code>}` |

Stable invalid issue codes include `unsupported_session_provider`,
`provider_mode_mismatch`, and `invalid_session_id`. No exact-provider path
returns `SessionExistence::Absent`. History state and pane kind cannot alter
this table; pane-kind support is validated before lookup.

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
- `crates/freshell-protocol/src/common.rs`
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
- New: `crates/freshell-sessions/src/opencode_database.rs`
- `crates/freshell-sessions/src/parse/opencode.rs`
- `crates/freshell-sessions/src/directory_index.rs`
- `crates/freshell-sessions/src/opencode_locator.rs`
- `crates/freshell-sessions/src/indexer.rs`
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
- `crates/freshell-opencode/src/serve.rs`
- `crates/freshell-opencode/src/transport.rs`
- New: `crates/freshell-server/src/opencode_composition.rs`
- `extensions/opencode/freshell-rebind-plugin.ts`
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
- `src/components/DeadSessionPanel.tsx`
- `src/store/paneTypes.ts`
- `src/store/panesSlice.ts`
- `docs/index.html`

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
- New: `crates/freshell-server/tests/opencode_database_alignment.rs`
- `crates/freshell-protocol/tests/roundtrip.rs`
- `test/unit/client/lib/pane-reconcile.test.ts`
- New: `test/unit/client/lib/pane-reconcile-controller.test.ts`
- `test/unit/client/lib/ws-client.reconcile.test.ts`
- `test/unit/client/components/App.reconcile-adoption.test.tsx`
- New: `test/unit/client/components/TerminalView.reconcile.test.tsx`
- `test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx`
- `test/unit/client/components/DeadSessionPanel.test.tsx`
- `test/e2e-browser/specs/reconcile-handshake-rust.spec.ts`
- `test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts`
- `test/e2e-browser/playwright.config.ts`

---

### Task 1: Establish the Shared Recovery Contract and Close the Provider Boundary

**Files:**
- Add `crates/freshell-recovery/Cargo.toml`
- Add `crates/freshell-recovery/src/lib.rs`
- Add `crates/freshell-recovery/src/coordinator.rs`
- Add `crates/freshell-recovery/src/ownership.rs`
- Modify workspace `Cargo.toml` and `Cargo.lock`
- Modify `crates/freshell-freshagent/Cargo.toml`
- Modify `crates/freshell-ws/Cargo.toml`
- Modify `crates/freshell-server/Cargo.toml`
- Modify `crates/freshell-ws/src/existence.rs`
- Modify `crates/freshell-ws/src/reconcile.rs`
- Modify `crates/freshell-ws/src/pane_ledger.rs`
- Modify `crates/freshell-ws/src/pane_ledger_tests.rs`
- Add `crates/freshell-server/src/recovery_providers.rs`
- Modify `crates/freshell-server/src/main.rs`
- Modify `shared/ws-protocol.ts`
- Modify `crates/freshell-protocol/src/common.rs`
- Modify `crates/freshell-protocol/src/client_messages.rs`
- Modify `crates/freshell-protocol/src/server_messages.rs`
- Modify focused protocol/reconcile tests

**Interfaces:**
- `RecoveryProviderRegistry`
- `ExactRecoveryQuery`, `ExactRecoveryState`, `ExactRecoveryIssue`
- `ExactRecoveryProof`
- `RecoveryOwnerKey` with provider-defined global/project scope
- `MaterializationState::{Allocated, Observed, Unknown}`
- provider-aware `validate_session_ref(mode, session_ref)`
- additive negotiated capability `paneReconcileExactV1`
- additive client messages `restore.launch.cancel{requestId}` and
  `restore.launch.ack{requestId}`, accepted only for a launch owned by that
  authenticated connection
- wire-neutral `Eq + Hash` support for `SessionLocator`, used only for
  normalized request-local deduplication

- [ ] **Step 1: Write RED tests for the closed boundary**

Cover terminal and fresh-agent panes:

- unknown/custom/Gemini/Kimi structured refs return
  `invalid{unsupported_session_provider}`;
- provider/mode mismatch is invalid;
- malformed/traversal/oversized IDs return invalid;
- an instrumented registry records zero root/filesystem/SQLite calls for every
  invalid case;
- valid IDs are:
  - Claude’s canonical hyphenated UUID contract (version 1–5, RFC variant);
  - a canonical hyphenated UUID for Codex using the UUID parser’s supported
    standard versions, including Codex’s current v7 IDs—do not reuse Claude’s
    narrower version validator;
  - OpenCode `ses_` followed by 1–124 ASCII alphanumerics (128 bytes total);
  - Amplifier 1–255 UTF-8 bytes and at most 255 UTF-16 code units,
    non-whitespace, neither `.` nor `..`, and one portable path component.
    Reject ASCII controls and Windows-reserved `< > : " / \ | ? *`, any
    drive/UNC/device prefix or alternate-data-stream colon, trailing dot/
    space aliases, and case-insensitive reserved basenames (even with an
    extension): `CON`, `PRN`, `AUX`, `NUL`, `CLOCK$`, `COM1`–`COM9`, and
    `LPT1`–`LPT9` including Windows’ superscript-digit aliases. Do not impose
    UUID-only; most real Amplifier IDs contain underscores.

Validation returns a canonical value used by lookup and ownership, not the
untrusted spelling: UUIDs are lowercase hyphenated, while OpenCode/Amplifier
remain case-preserving under their contracts. Reject compact/braced UUIDs.
Implement Amplifier validation as one host-independent lexical function and
call `PathBuf::join` only after it succeeds; native-Linux tests must exercise
the Windows cases too: drive-relative/absolute, UNC and device prefixes,
alternate streams, `CON`/`con.txt`, `COM1`/superscript aliases, trailing
dot/space, controls, and reserved punctuation. Every rejection remains in the
zero-I/O assertion.

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
root owns the concrete provider registry. Task 1 makes it
constructible/testable; Task 4 injects the same shared coordinator/owner into
WebSocket, REST, auto-resume, and fresh-agent state, and Task 5 activates the
complete runtime.

Make the registry the only route from a durable `SessionLocator` to store I/O.
Keep shell and non-resumable extension panes on their existing fresh behavior;
they may not claim durable recovery.

Keep this new exact path dormant in production through Tasks 1–3: do not
advertise `paneReconcileExactV1` or replace the legacy reconcile handler.
Tasks 2–4 install and test all provider/coordinator/owner components; Task 5
activates them only after every launch fence is present. Each intermediate
commit must preserve the currently supported legacy behavior while its new
APIs are exercised directly by focused tests.

- [ ] **Step 3: Write RED additive wire-capability tests**

Pin protocol parsing/serialization for offered, acknowledged, and omitted
`paneReconcileExactV1`. A server may echo it only when the client offered it
and the complete `ExactRestoreRuntime` is installed; otherwise it is omitted
while legacy `paneReconcileV1` remains unchanged. The capability is additive.
Do not change the request/result discriminants, the 200-pane limit, or the
frozen verdict enum. Also pin the additive cancel/ack frames; an old server
never receives them because a new client sends them only after exact
capability acknowledgement.

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
- global providers key rows by provider/session regardless of pane cwd;
- two Amplifier rows with the same textual ID and different validated project
  scopes coexist, survive reload, and resolve only with the matching cwd;
- an old unscoped Amplifier row loads as legacy/unknown scope and cannot
  authorize until an exact cwd-scoped proof disambiguates it. A successful
  launch writes a new scoped successor; the old row remains a read-only
  compatibility alias, is ignored whenever a matching scoped row exists, and
  is never deleted or treated as `Allocated`; and
- the scoped filename/index migration never overwrites or deletes an old row.

Simulate failure before/after the scoped successor write and reload the
ledger: migration is idempotent, the alias never shadows an existing scoped
row, and write failure remains retryable.

Run:

```bash
cargo test -p freshell-ws pane_ledger -- --nocapture
```

- [ ] **Step 5: Implement materialization persistence**

Add `materialization` and optional normalized `provider_scope` to
`BindingWrite`/ledger rows. Key new rows and filenames by `RecoveryOwnerKey`;
old rows remain readable in place. Add durable
`mark_materialized(owner_key)` using the ledger’s existing atomic write
discipline. Claude preallocation writes `Allocated`; exact provider positives
and authoritative association write `Observed`.

For a row currently marked `Allocated`, persisting the monotonic `Observed`
transition is part of making an artifact-positive verdict actionable. If that
internal ledger write fails, return retry rather than risk later treating a
once-materialized, subsequently deleted transcript as a zero-turn allocation.
Provider stores remain read-only. Add a batched ledger operation so a
17-pane reconcile performs one serialized ledger transaction rather than 17
independent lock acquisitions.

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
cargo check --workspace
cargo fmt --check
git diff --check
git add Cargo.toml Cargo.lock crates/freshell-recovery crates/freshell-protocol \
  crates/freshell-ws crates/freshell-freshagent/Cargo.toml \
  crates/freshell-server shared/ws-protocol.ts
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
- Require a regular transcript file under the effective root. On Unix, open
  with nonblocking/no-follow protections before `fstat` so a FIFO, device,
  socket, or symlink cannot consume one of the four blocking slots.
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
- Treat the database path as untrusted data: the verified rollout must remain
  under the effective active/archive roots under the provider’s existing
  symlink policy. Traversal or an out-of-root/symlink escape is retryable and
  never opened for metadata.
- Verify the referenced file’s owned session metadata using Codex’s native
  permitted-leading-record rule, for both plain JSONL and zstd.
- Require regular SQLite/rollout files; reject FIFO/device/socket inputs
  without a blocking read and follow only the provider’s explicitly supported
  symlink policy.
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
within that effective root. A transcript-shaped FIFO/symlink/device fixture
must return retryable promptly without a reader/writer helper.
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
- DB path traversal, out-of-root target, and symlink escape;
- FIFO/device/socket/non-regular DB and rollout candidates return promptly;
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
cargo check --workspace
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
- Modify `Cargo.lock`
- Modify `crates/freshell-sessions/Cargo.toml`
- Add `crates/freshell-sessions/src/opencode_database.rs`
- Modify `crates/freshell-sessions/src/parse/opencode.rs`
- Modify `crates/freshell-sessions/src/parse/mod.rs`
- Modify `crates/freshell-sessions/src/directory_index.rs`
- Modify `crates/freshell-sessions/src/opencode_locator.rs`
- Modify `crates/freshell-sessions/src/indexer.rs`
- Modify `crates/freshell-sessions/src/lib.rs`
- Add `crates/freshell-sessions/tests/opencode_exact.rs`
- Modify `crates/freshell-sessions/src/amplifier_stub.rs`
- Modify `crates/freshell-platform/src/cli_launch.rs`
- Modify `crates/freshell-opencode/src/serve.rs`
- Modify `crates/freshell-opencode/src/transport.rs`
- Modify `crates/freshell-freshagent/src/lib.rs`
- Modify `crates/freshell-freshagent/src/opencode_ws.rs`
- Modify `crates/freshell-freshagent/src/terminal_tabs.rs`
- Modify `crates/freshell-ws/src/lib.rs`
- Modify `crates/freshell-ws/src/terminal.rs`
- Modify `crates/freshell-ws/src/opencode_association.rs`
- Add `crates/freshell-server/src/opencode_composition.rs`
- Modify `crates/freshell-server/src/main.rs`
- Modify `crates/freshell-server/src/session_directory.rs`
- Modify `crates/freshell-server/src/recovery_providers.rs`
- Add `crates/freshell-server/tests/opencode_database_alignment.rs`

**OpenCode contract:**

- Match the installed provider’s effective DB path:
  absolute/relative `OPENCODE_DB`, data-home resolution, and channel-specific
  filenames.
- Resolve an `OpencodeDatabaseLocation` once from immutable process
  environment at the server composition root. It carries the absolute DB
  path, watch paths, and normalized child `OPENCODE_DB` value. Inject that
  same value object into History, terminal association/locator, exact
  recovery, terminal CLI launch, and the shared fresh-agent serve manager;
  no consumer appends its own `opencode.db`.
- Validate the supported `session` schema and exact primary-key index.
- Query all requested IDs in one read-only WAL-aware connection/transaction.
- Require the selected database to be a regular file; a FIFO, device, socket,
  or unsupported symlink is retryable before SQLite opens it.
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
- Add a recovery-only
  `ensure_session_at_scope(&RecoveryOwnerKey, expected_cwd, session_id)` API.
  It accepts only an Amplifier owner whose proved project-store scope matches
  the cwd resolver, and it inspects/repairs/creates only
  `<that-scope>/sessions/<id>`. Exact launch code is forbidden from calling
  the compatibility `ensure_session`, whose global first-match behavior
  remains for legacy non-recovery callers.
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
Include a non-regular DB candidate that returns promptly without opening a
reader. Seed a conflicting sentinel DB at the old default path and assert it
is never consulted when an override/channel path wins.

- [ ] **Step 2: Implement the OpenCode batch query**

Extract the canonical location resolver and convert every consumer from
“data-home plus append” to the shared exact DB location. Normalize a relative
override according to the installed CLI’s rule, then inject its resulting
absolute value into both terminal and fresh-agent child environments so
reader and writer cannot choose different bases.

Add server composition integration tests for absolute override, relative
override, default, and channel-specific filename. In each case one fake
OpenCode row must be visible through History, bounded locator/association, and
exact lookup, while terminal and fresh fake launchers record the identical
absolute `OPENCODE_DB`. The old/default sentinel must remain invisible and
unchanged.

- [ ] **Step 3: Pin Amplifier compatibility and ambiguity RED tests**

```bash
cargo test -p freshell-sessions amplifier_stub -- --nocapture
```

Cover expected-cwd valid/partial/mismatched metadata, divergent slug, duplicate
global IDs, unreadable unrelated sibling, project symlink behavior, traversal,
missing stub, two concurrent restubs, and old/new `ensure_session` parity.
For duplicate textual IDs in projects A/B, prove A then assert scoped setup
touches only A; for allocated/missing A with existing B, restub A rather than
selecting B. Hash both project trees before/after.

- [ ] **Step 4: Implement the shared cwd-scoped lookup**

Separate the typed recovery adapter from the compatibility adapter used by
`ensure_session`; share traversal primitives, not incompatible error policies.
Return the opaque project-store scope and launch cwd in the exact proof, and
implement the scope-pinned setup API above. A scope mismatch is a typed error
before mutation.

- [ ] **Step 5: Run focused tests and commit**

```bash
cargo test -p freshell-sessions --test opencode_exact -- --nocapture
cargo test -p freshell-sessions opencode_locator -- --nocapture
cargo test -p freshell-sessions directory_index -- --nocapture
cargo test -p freshell-sessions amplifier_stub -- --nocapture
cargo test -p freshell-platform cli_launch -- --nocapture
scripts/sandbox-test.sh "cargo test -p freshell-opencode serve -- --nocapture"
scripts/sandbox-test.sh "cargo test -p freshell-freshagent opencode -- --nocapture"
cargo test -p freshell-ws opencode_association -- --nocapture
scripts/sandbox-test.sh "cargo test -p freshell-server --test opencode_database_alignment -- --nocapture"
cargo test -p freshell-server recovery_providers -- --nocapture
cargo check --workspace
cargo fmt --check
git diff --check
git add Cargo.lock crates/freshell-sessions crates/freshell-platform \
  crates/freshell-opencode crates/freshell-freshagent/src/lib.rs \
  crates/freshell-freshagent/src/opencode_ws.rs \
  crates/freshell-freshagent/src/terminal_tabs.rs \
  crates/freshell-ws/src/lib.rs crates/freshell-ws/src/terminal.rs \
  crates/freshell-ws/src/opencode_association.rs crates/freshell-server
git commit -m "feat(recovery): prove opencode and amplifier recovery identities"
```

---

### Task 4: Bounded Request-Local Reconciliation and One Cross-Kind Owner

**Files:**
- Modify `Cargo.lock`
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
- Modify `crates/freshell-terminal/Cargo.toml`
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
- The request waits at most 400 ms for an admitted batch, leaving wire/React
  headroom under the 500 ms acceptance limit. Timeout returns retry while the
  admitted blocking job continues holding its permit until exit. Exact SQLite
  connections use a short busy timeout within that budget rather than the
  History reader’s multi-second timeout.
- Final derivation rereads registry, identity, and ledger. A selected query
  absent from the request-local snapshot is retry.
- Live registry/ledger lookup uses the same `RecoveryOwnerKey`: two
  cwd-scoped Amplifier owners cannot attach/correct to each other, while
  global providers still attach despite stale/different pane cwd.
- Arbiter state participates in the final verdict: a compatible `Bound` owner
  attaches, `Claiming`/`Cleaning` returns `session_check_pending`, and an
  incompatible bound pane kind uses the stable conflict path. No in-progress
  owner can produce `respawn`.
- `Present` yields respawn; `AllocatedUnmaterialized(owner)` yields only the
  provider-specific same-ID launch path; unresolved misses/read races yield
  `error{session_check_pending}`; permanent unsupported/unavailable/conflict/
  invalid states use the shared terminal mapping above.
- Fresh-agent retry does not burn its respawn cap.
- History snapshots and `ever_observed` cannot turn unresolved exact evidence
  into present/absent/fresh/dead.
- The arbiter key is `RecoveryOwnerKey`, independent of pane kind and
  transport. Global providers ignore pane cwd; Amplifier uses its validated
  project-store scope. A claim has an opaque attempt ID and launch nonce; only
  that token may renew, bind, begin cleanup, or release it.
- Claims do not become stealable merely because a timer elapsed. A claimant
  renews while queued, setting up, and awaiting provider acknowledgement.
  Failed claims remain owned through process/logical-writer cleanup; release
  happens only after cleanup is confirmed. Bound ownership ends only on an
  authoritative process/session lifecycle event.
- Renewal runs at most every five seconds and is fenced by the attempt token.
  Initial acknowledgement uses each provider’s existing overall create/resume
  deadline (including Claude’s 45-second budget), not the obsolete 20-second
  lease TTL. Deadline expiry enters supervised cleanup.
- Add structured logs for admission, exact verdict, owner claim/contention,
  renewal, binding, cleanup, and release. Log provider, counts, stable hashed
  owner/query identifiers, and reasons—never raw cwd, prompts, or transcript
  content.

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
- an admitted >400 ms fake returns retry by the deadline while retaining its
  permit until the fake exits;
- a provider panic/join failure maps only its affected queries to retry,
  releases the permit, and leaves subsequent requests healthy;
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
unchanged request/result JSON vocabulary. Keep `paneReconcileExactV1`
unadvertised in this intermediate commit: an exact positive is not a complete
restore guarantee until Task 5 installs every create-time proof/identity
fence. Keep the production handler on its existing legacy engine in this
intermediate commit; exercise the exact engine directly in tests. Define the
components needed by an `ExactRestoreRuntime`, but do not add a truthy
configuration boolean that can drift from wiring. Task 5 constructs the
aggregate capability token only after it supplies every dependency, then
atomically switches all reconcile requests—including legacy-capability
clients—to the safer exact positive-only engine without changing their wire
shape.

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
release on authoritative exit. For Amplifier, the same textual ID and same
project scope contend, while the same textual ID in two independently proved
project scopes does not; for Claude/Codex/OpenCode, differing pane cwd values
must not split the global owner. Reconciliation/attach tests with both
Amplifier scopes live prove each pane selects only its own terminal.

```bash
cargo test -p freshell-recovery ownership -- --nocapture
scripts/sandbox-test.sh "cargo test -p freshell-ws --test session_ref_singleflight -- --nocapture"
scripts/sandbox-test.sh "cargo test -p freshell-ws --test cross_kind_liveness -- --nocapture"
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
scripts/sandbox-test.sh "cargo test -p freshell-ws --test cross_kind_liveness -- --nocapture"
cargo test -p freshell-server existence -- --nocapture
cargo check --workspace
cargo fmt --check
git diff --check
git add Cargo.lock crates/freshell-recovery crates/freshell-ws crates/freshell-freshagent \
  crates/freshell-terminal crates/freshell-server
git commit -m "fix(recovery): reconcile exact sessions off thread without guessing"
```

---

### Task 5: Fence Every Restore Launch with Current Proof and Initial Identity

**Files:**
- Modify `crates/freshell-recovery/src/ownership.rs`
- Modify `shared/ws-protocol.ts`
- Modify `crates/freshell-protocol/src/server_messages.rs`
- Modify `crates/freshell-protocol/tests/roundtrip.rs`
- Modify `crates/freshell-ws/src/terminal.rs`
- Modify `crates/freshell-ws/src/auto_resume.rs`
- Modify `crates/freshell-ws/src/lib.rs`
- Modify `crates/freshell-ws/src/claude_signal.rs`
- Modify `crates/freshell-ws/src/opencode_signal.rs`
- Modify `crates/freshell-ws/src/opencode_association.rs`
- Modify `crates/freshell-ws/src/codex_association.rs`
- Modify `crates/freshell-platform/src/cli_launch.rs`
- Modify `crates/freshell-terminal/src/registry.rs`
- Modify `crates/freshell-sessions/src/amplifier_stub.rs`
- Modify `crates/freshell-codex/src/launch_lifecycle.rs`
- Modify `crates/freshell-codex/src/remote_proxy.rs`
- Modify `extensions/opencode/freshell-rebind-plugin.ts`
- Modify `crates/freshell-freshagent/src/lib.rs`
- Modify `crates/freshell-freshagent/src/claude.rs`
- Modify `crates/freshell-freshagent/src/codex.rs`
- Modify `crates/freshell-freshagent/src/opencode_ws.rs`
- Modify `crates/freshell-freshagent/src/terminal_tabs.rs`
- Modify `crates/freshell-freshagent/src/pane_ops.rs`
- Modify `crates/freshell-server/src/main.rs`
- Modify provider launch and lifecycle tests
- Modify `test/unit/server/opencode-rebind-plugin.test.ts`

**Launch transaction:**

Every restore/resume entry point follows one order:

1. acquire the existing shared spawn permit;
2. derive and validate the candidate session reference, cwd, and
   materialization from current server authority, before resolving any root;
3. derive its `RecoveryOwnerKey` without provider mutation. For a legacy
   Amplifier ref lacking cwd, a bounded exact preflight may prove the unique
   project scope;
4. claim that global cross-kind owner key;
5. reread final authority and revalidate exact provider proof through the
   bounded coordinator while holding the claim. A changed key fails closed;
6. perform provider setup and launch;
7. await the first authoritative identity acknowledgement carrying this
   launch nonce;
8. atomically bind the global owner and persist the observed identity; then
9. answer the client and release the spawn permit.

Ownership remains held through step 8. Any preflight is advisory only; step 5
is the authority fence. On lost/wrong ownership proof, timeout, revocation,
identity mismatch, or launch failure, terminate and confirm the owned process
tree before releasing the owner. OpenCode’s shared sidecar is the explicit
exception: discard the failed logical session attempt and its routes without
killing unrelated sessions in the shared process.

“Atomically” at step 8 means externally fenced, not a fictitious cross-file
transaction: while the claim excludes contenders, persist the `Observed`
ledger row first, recheck resource liveness, then transition the in-memory
owner to `Bound` and emit the client response. A persistence/liveness failure
never exposes `Bound`; it enters cleanup. A crash after persistence is safe
because the new server starts with no in-memory owner and exact proof must run
again.

The transaction is cancellation-safe. Dropping the client socket, aborting
the request task, or unwinding after spawn transfers the claim and any owned
child/logical route to a server-supervised cleanup task. A destructor never
blindly frees the claim; the arbiter remains `Cleaning` until that supervisor
reports the resource gone.

Before a WebSocket launch waits for the spawn permit, register it under
`(connectionId, requestId)`. On an exact-capability connection,
`restore.launch.cancel{requestId}` aborts only that connection’s matching
transaction and enters the same supervised cleanup; it is idempotent and
cannot cancel another connection’s request. After sending the matching
created frame, retain a `BoundAwaitingClient` entry until the client folds it
and sends `restore.launch.ack{requestId}`; only that ack removes the
cancel-by-request path. A cancel racing the created frame therefore still
cleans the resource. Socket teardown cancels pre-created transactions; a
successfully created-but-unacked resource remains a normal background session
so reconnect reconciliation can attach it, then the old connection registry
entry is discarded. After ack, normal terminal/fresh-agent kill owns pane
closure. Bound-awaiting-client entries also expire after a 60-second grace
period with a warning, dropping only the request-cancel handle—never the
bound owner or process—so a silent client cannot leak registry memory.
REST launch futures use the same cancellation-safe guard but complete their
transaction when the HTTP response is committed; they do not use WS ack
frames.

Extend the existing request-correlated `error{code:"RESTORE_UNAVAILABLE"}`
envelope with one optional, typed `restoreReason` field. Its closed enum is
`proof_changed | identity_mismatch | identity_ack_timeout | owner_conflict |
binding_persist_failed | provider_setup_failed | launch_cancelled`. It is
omitted on every unrelated error, preserving old wire bytes; old clients
ignore it. Exact launch failure emits this error and no `*.created` frame.
REST surfaces return the equivalent typed reason in their structured non-2xx
response. Provider stderr/details stay in structured server logs and are not
exposed as session content.

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
before Amplifier’s scope-pinned `ensure_session_at_scope`/restub, managed
Codex app-server or proxy planning/`ensure_ready`, OpenCode manager
startup/config/MCP writes, or PTY spawn. Exact launch must never call
Amplifier’s global compatibility `ensure_session`.

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
  supported later in-pane rebind. The owned PTY observer handles chunk
  boundaries and ANSI decoration, scans at most 64 KiB before the provider
  deadline, and compares the complete decoded ID—not a substring. Before
  spawn, assert the actual PTY cwd resolves back to the proof’s project scope;
  the ID acknowledgement alone is not scope proof.

- [ ] **Step 1: Write RED launch-door and zero-side-effect tests**

Create a table-driven harness for every launch door above. Mutate the final
identity carrier while queued: structured ref, promoted mode/ref, terminal
identity, registry identity, ledger supersession terminus, and cwd. Delete,
replace, partially rewrite, or conflict the provider artifact after reconcile
but before launch.

Assert a newly selected invalid/unproved reference causes zero provider-store
and setup calls; failed proof causes no restub, app-server/proxy, OpenCode
manager/config write, PTY, or fresh runtime; retryable fresh outcomes do not
burn the respawn cap. With duplicate Amplifier IDs in projects A/B, launch A
uses the proof’s resolved cwd and scoped setup, the fake CLI reports A plus
the exact ID, and B’s tree remains byte-for-byte unchanged.

- [ ] **Step 2: Write RED provider acknowledgement tests**

For each supported terminal/fresh provider, cover matching first identity,
mismatch, missing acknowledgement timeout, stale nonce, duplicate signal, and
a later authenticated rebind where supported. Assert that mismatch/timeout
never persists or adopts the reported identity. Amplifier fixtures split and
ANSI-decorate the acknowledgement, include prefix-collision IDs, and exceed
the scan bound without a match.

Add protocol round trips proving every `restoreReason`, omission on ordinary
errors, request correlation for terminal and fresh-agent launches, and
forward-compatible deserialization by the frozen old-client fixture.

```bash
cargo test -p freshell-protocol --test roundtrip restore_launch -- --nocapture
scripts/sandbox-test.sh "cargo test -p freshell-ws launch_lifecycle -- --nocapture"
scripts/sandbox-test.sh "cargo test -p freshell-freshagent restore_identity -- --nocapture"
cargo test -p freshell-platform cli_launch -- --nocapture
npm run test:vitest -- run test/unit/server/opencode-rebind-plugin.test.ts --config config/vitest/vitest.config.ts
```

- [ ] **Step 3: Write RED cleanup and long-launch ownership tests**

Use controlled child processes and barriers at queue, proof, setup, spawned,
and acknowledgement phases. Hold each phase beyond the former 20-second lease
window and race a second claimant. Assert no auto-steal and at most one
process/logical writer. For each failure phase, assert cleanup completes before
another owner is admitted. Exercise process-tree cleanup in the destructive
sandbox; abort the request task and disconnect its socket at every phase;
prove cancellation hands cleanup to the supervisor; and prove the OpenCode
shared-sidecar exception removes only the failed logical route. Race
`restore.launch.cancel` before permit acquisition, during setup, after spawn,
and against the created-frame commit; verify same-connection idempotence and
cross-connection isolation. Verify created remains cancellable until a
same-connection `restore.launch.ack`, ack makes subsequent cancel a no-op, a
stale/wrong-connection ack cannot disarm cancellation, and disconnect after
created preserves one attachable background owner rather than killing or
duplicating it. Fake time proves the 60-second grace drops only the request
entry while the bound owner/resource remains attachable.

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
binding are committed together. Once every launch door uses this transaction,
construct `ExactRestoreRuntime` at the server composition root and acknowledge
`paneReconcileExactV1` only when the client offered it and that aggregate is
present. Its constructor requires the coordinator, arbiter, launch guard,
identity reporters, ledger, and cleanup supervisor; callers cannot set a
free-floating readiness bool. Add a handshake/integration assertion that
constructing server state without the aggregate keeps the capability omitted.
When the aggregate is present, route both exact-capability and legacy
`paneReconcileV1` requests through the exact engine; only the capability echo
controls whether a new client may release durable creates.

- [ ] **Step 6: Run focused checks and commit**

```bash
scripts/sandbox-test.sh "cargo test -p freshell-ws launch_lifecycle -- --nocapture"
scripts/sandbox-test.sh "cargo test -p freshell-freshagent restore_identity -- --nocapture"
cargo test -p freshell-platform cli_launch -- --nocapture
cargo test -p freshell-protocol --test roundtrip restore_launch -- --nocapture
cargo test -p freshell-ws capability_negotiation -- --nocapture
npm run test:vitest -- run test/unit/server/opencode-rebind-plugin.test.ts --config config/vitest/vitest.config.ts
scripts/sandbox-test.sh "cargo test -p freshell-ws --test session_ref_singleflight -- --nocapture"
scripts/sandbox-test.sh "cargo test -p freshell-ws launch_owner_lifecycle -- --nocapture"
scripts/sandbox-test.sh "cargo test --workspace --all-targets"
scripts/sandbox-test.sh "cargo test -p freshell-ws --test cross_kind_liveness -- --nocapture"
cargo check --workspace
cargo fmt --check
git diff --check
git add crates/freshell-recovery crates/freshell-ws crates/freshell-freshagent \
  crates/freshell-platform crates/freshell-terminal crates/freshell-sessions \
  crates/freshell-codex \
  crates/freshell-server extensions/opencode \
  crates/freshell-protocol shared/ws-protocol.ts \
  test/unit/server/opencode-rebind-plugin.test.ts
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
- Modify `src/components/DeadSessionPanel.tsx`
- Modify `src/store/paneTypes.ts`
- Modify `src/store/panesSlice.ts`
- Modify `docs/index.html`
- Add/modify focused client tests

**Controller contract:**

- One connection generation owns boot, auto retry, manual retry, and reconnect.
- WsClient offers additive `paneReconcileExactV1` alongside the existing
  legacy capabilities; only the echoed ready capability changes behavior.
- Durable restore authority requires the server to echo
  `paneReconcileExactV1`. If it is absent—with or without legacy
  `paneReconcileV1`—hold then discard every durable create without sending it
  and send no legacy reconcile request for those panes; show “Server update
  required to restore saved sessions.” Stateless panes proceed normally.
  “Start new” remains an explicit identity-clearing escape hatch.
- This fail-closed decision happens inside WsClient’s `ready` handling before
  it flushes the pre-ready create queue, generic pending messages, or
  reconnect replay. It cannot wait for a later React/App callback. The sender
  identifies durable creates through one shared classifier covering terminal
  coding-mode `restore`, any `sessionRef`, provider-mode `resumeSessionId`,
  saved coding-mode live handle, and Codex durability candidate, plus every
  fresh-agent resume/session carrier. Only an explicitly identity-free fresh
  create or identity-free shell create is stateless.
  No-capability and legacy-only servers therefore get zero durable creates
  even during mount/reconnect races.
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
- `respawn` releases exactly one create but retains the episode in a
  `launching` phase until a matching `terminal.created`/`freshAgent.created`
  arrives. A correlated `RESTORE_UNAVAILABLE`, invalid-session, provider
  mismatch, or launch-identity error moves that same pane to the actionable
  Retry/Start new state while preserving its durable reference; Retry runs a
  new exact reconcile rather than blindly resending the create. There is no
  automatic identity-clearing fallback after a failed exact launch.
- Classify the typed `restoreReason` for diagnostics/copy; any missing or
  future unknown reason on a correlated `RESTORE_UNAVAILABLE` still fails
  closed into the same actionable state.
- On a matching created frame, revalidate the pane fingerprint, commit the
  Redux/live handle, then send `restore.launch.ack`. If the pane was removed,
  replaced, or otherwise cannot accept the frame, send
  `restore.launch.cancel` instead and ignore it. Never ack before the store
  commit.
- The initial request sends at episode time 0. Retry delays are 250, 500,
  1,000, 2,000, 3,000, then 3,000 ms, bounded to a ten-second automatic
  episode. Follow-up attempts therefore occur at 250, 750, 1,750, 3,750,
  6,750, and 9,750 ms; the 12,750 ms attempt is never scheduled. A separate
  deadline settles/cancels the episode at ten seconds even if no further
  server frame arrives. Manual Retry starts a new episode and sends
  immediately.
- The ten-second deadline governs unresolved reconciliation only. Once a
  positive verdict enters `launching`, cancel its retry/deadline timers and
  wait for the server’s provider-specific create deadline and correlated
  created/error frame; do not kill a valid slow Claude restore at ten seconds.
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
  pre-ready tracked create, and ignores late results. If its exact episode is
  already `launching`, send one `restore.launch.cancel` before forgetting the
  request. Tab removal follows the same path.
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
- On the server-update-required state, Retry performs one reconnect/capability
  renegotiation; it still cannot send a durable create unless the new socket
  acknowledges exact recovery.

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
- the initial attempt occurs at 0 and exact retry attempts occur at 250, 750,
  1,750, 3,750, 6,750, and 9,750 ms, with no 12,750 ms attempt, and the
  independent 10-second deadline cancels the unresolved create;
- mixed settled/warming batches;
- positive reconcile followed by matching created acknowledgement, proof
  change, identity mismatch, acknowledgement timeout, and ledger-write
  failure; only the matching created frame finishes the episode, every error
  preserves the durable ref and sends no automatic fresh create;
- accepted created sends ack after the reducer commit; a stale/removed pane
  sends cancel and never ack; wrong-request created/ack frames do nothing;
- App boot + manual retry + reconnect stale-result interleavings;
- already-ready App bootstrap;
- exact-capability absent (both no capability and legacy-only): zero durable
  creates before and after App handles `ready`, explicit server-update UX,
  stateless creates unaffected;
- boot → manual Retry → late boot result within one connection generation;
- retry exhaustion cancels rather than flushes;
- permanent conflict/unavailable/invalid;
- close, terminal→browser, and fresh-agent→terminal during scheduled and
  in-flight retry and during the post-positive launching phase;
- terminal→different-terminal and fresh-agent→different-fresh-agent identity
  replacement, tab removal, close while disconnected, and late replies;
- launch-phase close/replace sends one cancel, ignores a racing created frame,
  and produces no orphan inventory entry or process;
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
both pane kinds remain gated until their exact outcome. Directly invoke
WsClient’s `ready` path with no capability and legacy-only capability, before
mounting App, and prove its pre-ready queue, generic queue, and reconnect
replay emit zero durable creates while a stateless create emits once. Use a
table covering every durable carrier above so a missing `sessionRef` cannot
smuggle a saved live handle or Codex candidate through the legacy flush.

```bash
npm run test:vitest -- run \
  test/unit/client/lib/ws-client.reconcile.test.ts \
  test/unit/client/components/App.reconcile-adoption.test.tsx \
  test/unit/client/components/TerminalView.reconcile.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx \
  test/unit/client/components/DeadSessionPanel.test.tsx \
  --config config/vitest/vitest.config.ts
```

- [ ] **Step 5: Implement view and sender changes**

Add accessible copy and controls:

- delayed transient: “Restoring N saved panes…”
- unresolved after retries: “Freshell couldn’t find or read this saved
  session.”
- provider unavailable: “Freshell can’t access this provider’s saved sessions
  on this server.”
- conflict: “Freshell found more than one saved session with this identity and
  won’t guess.”
- invalid/unsupported: “This pane’s saved session information isn’t supported
  or is no longer valid.”
- old server: “Server update required to restore saved sessions.”
- buttons: “Retry” and “Start new”
- helper text beside Start new: “Starts an empty session in this pane. It does
  not delete the saved session.”

Use semantic buttons, labels, and `role="status"` for transient text; reserve
`role="alert"` for the terminal actionable state.

Update the nonfunctional `docs/index.html` mock so its recovery example and
copy match the new delayed restoring state, Retry, Start new, and
server-update-required behavior.

- [ ] **Step 6: Run focused checks and commit**

```bash
npm run test:vitest -- run \
  test/unit/client/lib/pane-reconcile.test.ts \
  test/unit/client/lib/pane-reconcile-controller.test.ts \
  test/unit/client/lib/ws-client.reconcile.test.ts \
  test/unit/client/components/App.reconcile-adoption.test.tsx \
  test/unit/client/components/TerminalView.reconcile.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx \
  test/unit/client/components/DeadSessionPanel.test.tsx \
  --config config/vitest/vitest.config.ts
npm run typecheck
npm run lint
git diff --check
git add src test/unit/client docs/index.html
git commit -m "fix(recovery): restore panes through one automatic reconcile controller"
```

---

### Task 7: Causal Cold-History, Compatibility, and Incident-Scale Browser Proof

**Files:**
- Modify `test/e2e-browser/playwright.config.ts`
- Modify `test/e2e-browser/specs/reconcile-handshake-rust.spec.ts`
- Modify `test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts`
- Modify `test/e2e-browser/helpers/rust-server.ts` only if cleanup support is
  shared there
- Add a small Node FIFO-holder fixture under `test/e2e-browser/fixtures/`

- [ ] **Step 1: Add raw-wire provider and scale coverage**

First add `reconcile-handshake-rust.spec.ts` to both `RUST_ONLY_SPECS` and the
`rust-chromium` project’s `testMatch`; add a configuration test/assertion that
the project actually enumerates it. The named verification command must fail
if Playwright selects zero tests.

Seed disposable exact stores for Claude, Codex active/archive/zstd, OpenCode,
and Amplifier. Cover HOME-unset provider overrides, terminal/fresh-agent
present/retry/conflict, 17 unique queries, 201/417 client batching, and a
delayed-ack launch cancelled by pane close.

Assert first-response verdicts and structured logs; do not click Retry in any
successful restore test. The cancelled launch leaves no tagged process,
logical route, owner, or terminal-inventory entry.

- [ ] **Step 2: Add a causal, cancellable History gate**

Linux/WSL-only:

Register this case only in the Linux/WSL project; do not add a runtime
`test.skip`. Cross-platform unit tests still cover helper state/cleanup, while
the real FIFO causal proof runs wherever the Rust browser project’s supported
Linux environment is available.

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
- whether the transient status ever enters the DOM, recorded by a
  pre-restart `MutationObserver` rather than a final-state query that could
  miss a flash;
- fake process count and identity;
- health/unrelated WS latency;
- exactly one process/writer per session;
- tab/pane preservation through abrupt scratch-server restart; and
- fixture teardown reaps every tagged fake-provider process, even on failure.

- [ ] **Step 4: Add old/new timing compatibility coverage**

Build and cache frozen base artifacts from commit `67519888` once, record their
hashes, and verify those hashes before each compatibility cell so candidate
sources cannot leak into the base bundle. Exercise:

- candidate client + candidate server: exact capability acknowledged and
  successful durable restore;
- candidate client + base server: exact capability absent, zero durable
  reconcile requests/creates, explicit server-update UX, stateless pane still
  starts, and even a fixture-injected unsolicited legacy
  `fresh`/`dead_session`/`respawn` frame is ignored;
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
scripts/sandbox-test.sh 'npm run test:e2e -- --project=rust-chromium test/e2e-browser/specs/reconcile-handshake-rust.spec.ts'
scripts/sandbox-test.sh 'npm run test:e2e -- --project=rust-chromium test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts'
scripts/sandbox-test.sh 'npm run test:e2e -- --project=rust-chromium --workers=1 --retries=0 --repeat-each=20 test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts -g "17 durable panes restore while History remains blocked"'
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
PORT=39482 npm run build

cargo test -p freshell-freshagent claude_snapshot -- --nocapture
cargo test -p freshell-sessions --test codex_exact -- --nocapture
cargo test -p freshell-sessions --test opencode_exact -- --nocapture
cargo test -p freshell-sessions amplifier_stub -- --nocapture
cargo test -p freshell-recovery -- --nocapture
cargo test -p freshell-ws --test pane_reconcile -- --nocapture
cargo test -p freshell-ws --test pane_reconcile_freshagent -- --nocapture
scripts/sandbox-test.sh "cargo test -p freshell-ws --test cross_kind_liveness -- --nocapture"
scripts/sandbox-test.sh "cargo test -p freshell-ws launch_lifecycle -- --nocapture"
scripts/sandbox-test.sh "cargo test -p freshell-freshagent restore_identity -- --nocapture"
scripts/sandbox-test.sh "cargo test -p freshell-ws --test session_ref_singleflight -- --nocapture"
scripts/sandbox-test.sh "cargo test -p freshell-ws launch_owner_lifecycle -- --nocapture"
scripts/sandbox-test.sh "cargo test --workspace --all-targets"

npm run test:vitest -- run \
  test/unit/client/lib/pane-reconcile.test.ts \
  test/unit/client/lib/pane-reconcile-controller.test.ts \
  test/unit/client/lib/ws-client.reconcile.test.ts \
  test/unit/client/components/App.reconcile-adoption.test.tsx \
  test/unit/client/components/TerminalView.reconcile.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx \
  test/unit/client/components/DeadSessionPanel.test.tsx \
  --config config/vitest/vitest.config.ts

scripts/sandbox-test.sh 'npm run test:e2e -- --project=rust-chromium test/e2e-browser/specs/reconcile-handshake-rust.spec.ts test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts'
scripts/sandbox-test.sh 'npm run test:e2e -- --project=rust-chromium --workers=1 --retries=0 --repeat-each=20 test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts -g "17 durable panes restore while History remains blocked"'

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
