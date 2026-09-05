# Fresh-Agent /undo + /redo Conversation Rollback Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Implement kata freshell#1wxv via the the-usual-beta workflow: /undo and /redo conversation rollback for fresh-agent panes (freshclaude/freshcodex/freshopencode, kilroy), per the owner-approved 10-decision spec recorded in kata 1wxv's body: conversation-only rollback (file side effects untouched; file rewind is the separately shipped "Rewind code to here"), /undo removes one turn-step and overwrites the composer with the removed prompt for edit-and-resend, per-turn rollback icon beside each user turn's existing fork icon performs "undo to here" (N turns in one action), /redo walks forward and is permanently destroyed by any new submission (send/steer/queue), rolled-back turns vanish from the active pane (live transcript equals what the model sees next) but persist in durable session history with a "rolled back" marker, pending permission cards inside undone turns are cancelled, rollback rejected mid-turn with a pointer to steer/queue, no confirmation dialogs, capability-gated providers with explicit unsupported rejection, and rollback state recorded in the session's durable record so refresh/remount/other devices observe identical transcript and redo availability; undoing revokes the undone turn's attention/green state and never chimes. Provider primitives (verified 2026-08-22): freshopencode native message-targeted revert/unrevert; freshcodex native in-place history revert thread/revert{beforeTurnId} (experimental surface; no native redo — codex v1 declares undo-only); freshclaude/kilroy via resume + resumeSessionAt + forkSession fork-at-point emulation, with redo by re-forking at a later point from the retained original session.

### Explicit constraints
- Execute via the the-usual-beta skill six-stage workflow.
- Work only in the dedicated worktree /home/dan/code/freshell/.worktrees/freshagent-undo-redo on branch the-usual/freshagent-undo-redo from origin/main (base_ref 530f5f3530dd660209fae11a81fc028827cdeb2e); never commit behavior changes to main or push to origin/main; no PR without explicit user approval.
- Red-Green-Refactor TDD with unit and e2e coverage; respect repo coordinated test gates; scope limited to kata 1wxv.
- The kata 1wxv body (updated 2026-08-22) is the authoritative product spec.

### Accepted tradeoffs and residuals
- Codex v1 ships undo only; no redo affordance appears for freshcodex (native history revert is destructive) and this must be explicit in UI copy, not silently missing.
- Rollback never touches files; opencode's snapshot-driven file revert is not enabled by this feature.
- Claude redo relies on the original session retaining full history (fork-at-point from it).

**Goal:** Every fresh-agent pane (freshclaude, kilroy, freshcodex, freshopencode) gains `/undo` and `/redo` slash commands plus a per-user-turn "Undo to here" rollback icon, performing conversation-only rollback that instantly trims the live transcript, refills the composer with the removed prompt, cancels pending cards, revokes attention, and persists rollback state durably enough that refresh, remount, and other devices see the identical transcript and redo availability.

**Architecture:** Two new WS client frames (`freshAgent.undo` / `freshAgent.redo`, mode `'step'|'toTurn'`, `turnId` for `toTurn`) ride the frozen wire contract (version 7→8) and route in `crates/freshell-ws/src/terminal.rs` to one `handle_rollback` per provider: codex calls the new `thread/revert` app-server client method (undo-only; the removed tail is captured *before* the destructive RPC); opencode calls new `POST /session/{id}/revert` / `unrevert` serve methods (stepwise redo = re-revert to a later messageID); freshclaude/kilroy kill-and-recreate the sidecar with `{resume, resumeSessionAt, forkSession: true}` fork-at-point and adopt the new durable id through the existing `sdk.session.init` machinery (redo = re-fork at a later point from the retained *original* session). A durable rollback record (rollback rows in the pane ledger, reached via a `PaneIdentitySink` extension) carries the removed turns (the "rolled back" marker bucket), the refill prompt, redo availability, and claude's original-session id; snapshot builders surface it under strict-contract keys; a broadcast `freshAgent.session.rolledBack`/`.redone` event converges sibling clients and revokes attention, while a requesting-sink ack carries the removed prompt for composer refill.

**Tech Stack:** Rust workspace (`freshell-ws`, `freshell-freshagent`, `freshell-codex`, `freshell-opencode`, `freshell-protocol`, `freshell-server`) + the Node claude sidecar (`crates/freshell-claude-sidecar/index.mjs`); React 18 + Redux Toolkit + Zod client (`src/`), shared contract modules (`shared/`), frozen WS port contract (`port/contract/`); Vitest unit/suite configs, Cargo tests, Playwright rust-chromium e2e against hermetic provider fakes.

## Global Constraints

- Worktree/branch: everything happens in `/home/dan/code/freshell/.worktrees/freshagent-undo-redo` on branch `the-usual/freshagent-undo-redo` (base `530f5f3530dd660209fae11a81fc028827cdeb2e`). Never commit to `main`; never push to `origin/main`; no PR without explicit user approval. Committer identity is the repo/global config — do not touch git config.
- TDD: Red-Green-Refactor per task. Tests fail first for the stated missing behavior. Never reduce coverage or weaken assertions to pass.
- The legacy TypeScript server (`server/`) is NOT modified by this feature (kata z04y retirement policy). Rollback v1 is WS-only: no REST routes and no agent-api/MCP rollback twin.
- Server is NodeNext/ESM: relative imports under `server/`/`shared/` keep `.js` extensions. (The shared zod modules above are imported by both client and server.)
- The frozen WS contract workflow is mandatory for wire changes: edit `shared/ws-protocol.ts` → `npm run contract:generate` → update `crates/freshell-protocol` inventory arrays/counts → commit the regenerated `port/contract/*.json` in the same commit. `test/unit/port/ws-contract-freeze.test.ts` (via `npm run test:port`) + `.github/workflows/port-contract.yml` enforce this.
- Rust gates per task: `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo clippy -p freshell-codex -p freshell-opencode --features real-transport --all-targets -- -D warnings`. Toolchain 1.96.0.
- Coordinated gates: check `npm run test:status` before any broad run; wait on a foreign holder; label broad runs with `FRESHELL_TEST_SUMMARY`. `FRESHELL_VITEST_BACKEND=cloud` and `FRESHELL_E2E_BACKEND=cloud` are set; the new e2e spec must actually pass on cloud (never add it to `CLOUD_SKIP_SPECS`; keep every test ≤120s wall).
- Destructive process-kill suites stay inside `scripts/sandbox-test.sh`; none of this plan's tests need the sandbox.
- Process safety: never restart the live self-hosted server (`scripts/launch-rust.sh --stop/--restart` on port 3001) without the user's explicit "APPROVED"; never broad-kill (`pkill node`, `pkill -f vite`); worktree dev servers use a unique port + recorded PID.
- A11y (CI-gated via `npm run lint`, eslint-plugin-jsx-a11y): every new interactive element is a semantic `<button>` with a discernible `aria-label`; tooltips/name attribute the affected step.
- Copy is pinned verbatim in the Wire Design section below; implementers use those exact strings (constants in `src/lib/fresh-agent-rollback.ts` / `crates/freshell-freshagent/src/rollback_record.rs`).
- Each task commits atomically with a conventional message; only that task's files are staged.

## Kata decision → task coverage map

| Kata 1wxv decision | Covered by |
|---|---|
| 1 Conversation-only scope (files untouched) | Tasks 2–4 (no file writes anywhere on the rollback path); Task 7 e2e asserts zero checkpoint-restore calls |
| 2 /undo = one turn-step | Provider boundary math: Task 2 (`resolve_codex_boundary`, last raw turn), Task 3 (last active user message), Task 4 (`resolve_resume_point`, last user group) |
| 3 "Undo to here" N-step single op + per-turn icon beside fork | Task 2/3/4 `toTurn` mode; Task 6 icon via `buildTurnActionItems` + hover toolbar |
| 4 Composer refill overwrite | Task 6 `replaceText` + ack handling; payloads from Tasks 2–4 acks |
| 5 Redo validity + destroyed on submission | Tasks 2–4 (record semantics, `destroy_redo_on_submit` in every `handle_send`); Task 6 destroyed copy |
| 6 Rolled-back vanish live, persist marked in durable history; pending cards cancelled | Task 5 (`rolledBackTurns` snapshot bucket); Task 4 (claude pending-cancel frames pre-teardown) |
| 7 Mid-turn lockout with steer/queue pointer | Busy gates in Tasks 2–4 (`BUSY_TURN`); client gates in Task 6 |
| 8 No confirmations; entry points slash + icon + context menus; tooltips name the step | Task 6 (catalog, toolbar, `buildTurnActionItems`, pane-menu registry items); no `window.confirm` added anywhere |
| 9 Capability gating per provider with explicit rejection | Task 1 (`capabilities.undo/redo`, refusal surface); Task 5 (stamps); Task 6 (hidden icons + explicit rejections) |
| 10 One truth everywhere (durable record; cross-device; revoke attention; never chime) | Task 1 (ledger rollback rows); Tasks 2–4 (AWAITED record writes, broadcast); Task 5 (snapshot surfacing); Task 6 (`SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS`, revoke thunk, no `recordTurnComplete` dispatch); Task 7 (multi-client + reload e2e) |

## Wire design (single reference; not repeated per task)

### Client → server frames (new, frozen contract v8)

```text
freshAgent.undo { type, requestId: string(required), sessionId, sessionType, provider, cwd?, mode?: 'step'|'toTurn' (absent => 'step'), turnId?: string }
freshAgent.redo (identical shape)
```

Both join `FreshAgentClientMessageSchema` and the top-level `ClientMessageSchema` in `shared/ws-protocol.ts`, get serde structs + `ClientMessage` arms + `CLIENT_MESSAGE_TYPES` entries in `crates/freshell-protocol` (31→33 client discriminants; server stays 58; combined 89→91). `turnId` absent on a `toTurn` frame is a *server-side* validation error (`INVALID_ROLLBACK_TARGET` on the requesting sink), not a zod refinement (discriminated unions require bare `ZodObject` members).

### Server → client (all ride the existing opaque `freshAgent.event` envelope; no new `ServerMessage` variants)

Requesting-sink ack (only the initiating pane's connection):

```json
{ "type": "freshAgent.rolledBack", "requestId": "...", "sessionId": "<live id>", "direction": "undo", "mode": "step", "removedPromptText": "...", "removedTurnIds": ["..."], "canRedo": true, "newSessionId": "<claude only>" }
{ "type": "freshAgent.redone", "requestId": "...", "sessionId": "<live id>", "direction": "redo", "restoredThroughTurnId": "...", "canRedo": false, "newSessionId": "<claude only>" }
```

Broadcast (every connection incl. the requester; converges sibling clients per decision 10; carries no prompt text so other devices' composers are untouched):

```json
{ "type": "freshAgent.session.rolledBack", "sessionId": "<live id>", "removedTurnIds": ["..."], "canRedo": true, "revokeAttention": true }
{ "type": "freshAgent.session.redone", "sessionId": "<live id>", "restoredThroughTurnId": "...", "canRedo": false }
```

Failures (requesting sink, except the pre-dispatch refusal in Task 1 which answers the same shape):

```json
{ "type": "freshAgent.error", "sessionId": "...", "code": "<code>", "message": "<pinned copy>", "requestId": "...", "rollback": true }
```

Codes: `UNSUPPORTED_CAPABILITY` (unsupported provider/op; amplifier always; codex redo permanently), `INVALID_SESSION_ID` (unknown/unmaterialized session — client recovery engages), `BUSY_TURN` (mid-turn), `INVALID_ROLLBACK_TARGET` (missing/unknown turnId, nothing-to-undo uses `NOTHING_TO_UNDO`), `REDO_UNAVAILABLE` (redo destroyed/absent), `INTERNAL_ERROR` (provider RPC failures, duplicate in-flight). Claude pane re-key rides the existing `freshAgent.session.materialized` broadcast (no new mechanism).

### Pinned copy (verbatim; tasks reference by constant name)

- `ROLLBACK_BUSY_MESSAGE` (server `BUSY_TURN`, shared by all providers): `Rollback is not supported while a turn is running — queue a steer message or wait for the turn to finish.`
- Refusal-table parity text: `"Undo is not supported for <sessionType>"` / `"Redo is not supported for <sessionType>"` (same `"<Op> is not supported for <sessionType>"` shape as the fork/compact cells).
- `REDO_CODEX_UNSUPPORTED_NOTICE` (client, codex /redo and codex redo rejections): `Redo is not available for Codex sessions — undo permanently replaces codex thread history (codex has no redo primitive). Rolled-back turns stay listed below the transcript.`
- `ROLLBACK_UNSUPPORTED_NOTICE` (client, any other capability-false provider): `Conversation rollback is not supported for <providerLabel> sessions.`
- `ROLLBACK_BUSY_UNDO_NOTICE` (client gate): `Undo is unavailable while the agent is mid-turn — queue a message to steer it, or wait for the turn to finish.`
- `ROLLBACK_BUSY_REDO_NOTICE` (client gate): `Redo is unavailable while the agent is mid-turn — queue a message to steer it, or wait for the turn to finish.`
- `REDO_DESTROYED_NOTICE` (client `REDO_UNAVAILABLE`): `Redo is no longer available — a message submitted after the undo permanently retired it.`
- `REDO_EMPTY_NOTICE`: `Nothing to redo.`
- `UNDO_EMPTY_NOTICE`: `Nothing to roll back.`
- `UNDO_REFILL_NOTICE` (after refill): `Undone — the removed prompt is back in the composer for editing.`
- `REDO_REMOVED_HISTORY_COPY` (server `REDO_UNAVAILABLE`, claude original-history-changed): `Redo is no longer available — the original conversation's history changed since the undo.`
- `LEDGER_WRITE_REFUSAL_COPY` (server `INTERNAL_ERROR`, rollback-record pre-write failure — the provider history is NEVER mutated on this path): `Undo is unavailable right now — the rollback record could not be saved. Try again.`
- `CODEX_OLD_CLI_COPY` (server `UNSUPPORTED_CAPABILITY`, codex predates `thread/revert`): `Rollback requires a newer Codex CLI (codex ≥0.149). Check the freshcodex sidecar logs for the exact error.`
- `OPENCODE_OLD_CLI_COPY` (server `UNSUPPORTED_CAPABILITY`, opencode predates the revert route): `Rollback requires a newer OpenCode CLI (opencode ≥1.18). Check the serve logs for the exact error.`

(`CODEX_LEGACY_THREAD_COPY` stays pinned in the corrections section, item 1.)

### Snapshot surface (strict contract; all keys optional so legacy-server payloads still parse)

- `FreshAgentCapabilitiesSchema` gains `undo: z.boolean().optional()`, `redo: z.boolean().optional()`. Stamps (busy gating stays client-side): codex `{undo:<true iff CodexSession.history_mode == Some(Paginated) — session-scoped per Task 5, NEVER live-probed (the app-server has no mode read-back); the DURABLE source is the rollout's persisted session_meta.history_mode (r3): set Some(Paginated) at thread/start and REHYDRATED by parsing that durable meta at every resume/adoption (validator-C proved the mode persists there; freshell-codex already reads rollouts for durability) — only a missing/unparseable mode stamps legacy undo:false, so a paginated thread keeps undo capability across normal session rehydration>, redo:false}`; claude (freshclaude AND kilroy) `{undo:true, redo:true}`; opencode `{undo:true, redo:true}`. Legacy TS server emits neither key → client treats absent as false.
- `FreshAgentTurnSchema` gains `rolledBack: z.boolean().optional()`.
- `FreshAgentSnapshotSchema` gains `rolledBackTurns: z.array(FreshAgentTurnSchema).optional()` (each stamped `rolledBack:true`) and `rollback: z.object({ canRedo: z.boolean(), undoneDepth: z.number().int().nonnegative() }).strict().optional()`. `turns[]` always equals exactly what the model sees next (prefix) — the marker bucket is separate.
- Snapshot `revision` takes `max(existingBasis, rollbackRecord.lastOpAtMs)` in every builder so the client's monotonic revision watermark never drops the post-rollback snapshot.

### Durable rollback record (decision 10's record)

New row kind in the pane ledger (`crates/freshell-ws/src/pane_ledger.rs`), payload-opaque to the ledger; the schema is owned by `crates/freshell-freshagent/src/rollback_record.rs`:

```rust
pub const ROLLBACK_RECORD_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackRecord {
    pub version: u32,
    /// Revision floor (wall-clock ms of the last rollback op).
    pub last_op_at_ms: i64,
    /// Any new submission (send/steer/queue firing) sets this: redo permanently dies (decision 5),
    /// the marker bucket survives (decision 6).
    pub redo_destroyed: bool,
    /// Redo availability STAMPED AT WRITE TIME by the provider handler — never derived at read:
    /// codex always false; opencode `!redo_destroyed && rebuilt tail non-empty`; claude
    /// `original tip strictly beyond the new current tip` (verified against the original JSONL
    /// at write time). Claude `entries` carry the union marker slices (r3) — an entries-derived bit can
    /// never work for it regardless (its redo validity is tip-vs-tip over the original).
    pub can_redo: bool,
    /// Claude fork-chain root (the session retaining full history). None for codex/opencode.
    pub original_session_id: Option<String>,
    /// Claude redo-validity anchor: the raw-chain tip uuid of the ORIGINAL transcript recorded
    /// at undo time; the redo path re-reads the original and requires tip == recorded tip
    /// (plus an LCP resolve past the redo target), else `REDO_UNAVAILABLE` +
    /// `REDO_REMOVED_HISTORY_COPY`. None for codex/opencode and for a fresh record.
    pub original_tip_uuid: Option<String>,
    /// Removed display turns as verbatim FreshAgentTurn JSON (rolledBack stamped at read, not stored).
    pub entries: Vec<RollbackEntry>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackEntry {
    pub removed_turns: Vec<serde_json::Value>,
    /// Plain text of the first removed USER turn — the composer-refill payload.
    pub prompt_text: String,
    pub at_ms: i64,
}
```

Per-provider record semantics (defined here, referenced by the provider tasks):

- **markers accumulate (r3 UNION rule, supersedes every "entries cleared"/"markers drop out" statement below):** `entries` is the UNION of EVERY epoch's rolled-back turns — frozen prior-epoch markers first (in their original conversation order), then the current epoch's markers (conversation order) — DURABLE in the ledger even after native provider deletion (codex revert destroys the tail; opencode deletes it on the next send; only the ledger satisfies decision 6's "persist marked", while decision 5's submission-destroy kills ONLY redo). Entries are NEVER dropped by an epoch reset, a send, or `destroy_redo_on_submit`; a redo removes EXACTLY the restored turns from the CURRENT-epoch portion (only current-epoch turns are restorable — the chain-root/pointer math cannot name frozen prior-epoch ids).
- **codex** — `entries` = the accumulating union (one entry pushed per undo; never popped: no redo exists; an epoch reset does NOT restart the list — r3). `rolledBackTurns` = flattened entry turns. New-send destroy sets `redo_destroyed` (markers stay). `can_redo` is stored false at every write.
- **opencode** — after every op the CURRENT-epoch portion of `entries` is REBUILT to exactly the current serve-revert tail (single entry when non-empty, in the tail's ORIGINAL CONVERSATION ORDER), while FROZEN prior-epoch markers PRECEDE it: frozen markers are the recorded entries whose turn ids no longer appear in the serve's message list (their tail rows were natively DELETED by a resend — they persist only in the ledger, r3). `can_redo` is stored at write time: `!redo_destroyed && rebuilt current tail non-empty`. The serve owns the current chain's boundary pointer (top-level `session.revert.messageID`); the record owns the destroyed bit, the stored `can_redo`, and the union marker bucket.
- **claude/kilroy** — `original_session_id` = the CURRENT epoch's chain-root durable id; `original_tip_uuid` = that original's raw-chain tip uuid recorded at undo time. `entries` NO LONGER stays empty (r3): each undo APPENDS that op's removed display-turn slice to the union (in conversation position), and each redo removes the restored turn ids from the CURRENT-epoch portion — the snapshot bucket is sourced from ledger `entries` (union), durable even if an old original's JSONL is later compacted or garbage-collected. `can_redo` is stored at write time: `!redo_destroyed && original tip strictly beyond the new current tip` — never `entries`-derived; the redo VALIDATION still re-reads the chain root (tip equality + LCP) per the contract below.
- **epochs (r3)** — a new UNDO landing while `redo_destroyed` is true starts a NEW epoch that clears ONLY the *redo-capable chain state*: the record's redo fields henceforth describe the NEW chain — `redo_destroyed` clears (the PRIOR chain's redo stays permanently dead: its provider tail no longer exists, so it can never be restored — "stays true for the prior chain"), `can_redo` is restamped per provider, and the per-epoch chain root is replaced at the new undo — (claude) `original_session_id`/`original_tip_uuid` re-root to the CURRENT durable id/tip, (opencode) the serve pointer retargets via the new revert, (codex) n/a (undo-only). `entries` (the marker union) is NEVER cleared. `destroy_redo_on_submit` keeps destroying redo on EVERY submission regardless of epoch and never touches `entries`. Task 5 snapshot sourcing (r3): `rolledBackTurns` = the ledger `entries` union; `canRedo`/redo math = the current-epoch chain state only.
- **legacy epochless rows (focused-review ep1-r4 F2 — accepted conservative tradeoff):** a pre-epoch-fields durable row loads migrated in memory (`from_stored_payload`): entries freeze (epoch 0), `currentEpoch` bumps, and the stored `canRedo` is FORCED OFF on anchor-less (opencode/codex) rows. The tradeoff: an epochless row cannot prove which of its frozen steps remain redoable at the provider (undo → partial redo → stop reads identically to all-steps-outstanding), and admitting a pointer-lane redo on the stale bit restores ONE step, then the current-epoch-only restamp permanently truncates the still-valid remainder — so the migrated row refuses `/redo` typed-cleanly (`REDO_UNAVAILABLE` + `REDO_EMPTY_MESSAGE`) with ZERO provider mutation traffic, the frozen markers are preserved verbatim (decision 6), and a NEW undo records into the bumped epoch and re-establishes redo truthfully for the new tail only. Claude-anchored rows (`originalSessionId` present) KEEP the stored bit: the claude lane never admits a redo on it (chain-anchored admission + per-op re-derivation), so forcing it off would only darken a redo the chain could still validate. The disk row is never lazily rewritten; the migration persists with the next op's write. (Code: `rollback_record.rs::from_stored_payload`, `opencode_ws.rs` redo admission; fake-harness raw-bytes seeding: `identity_sink.rs::FakeIdentitySink::seed_rollback_payload`.)

Storage layout: `~/.freshell/pane-ledger/rollback/<enc(provider)>/<enc(sessionId)>.json`, same atomic temp+rename+fsync discipline as binding rows (`write_row_atomic`), write-through in-memory index answering sync reads, per-row quarantine on corruption (never per-store). Write discipline (durable-BEFORE-mutation): the post-op record is computed from the pre-mutation reads, then AWAITED BEFORE the provider mutation runs — a pre-write failure REFUSES the rollback with `INTERNAL_ERROR` + `LEDGER_WRITE_REFUSAL_COPY` and the provider history is NEVER mutated. On Claude the record is keyed by the current durable id BEFORE the fork, and the existing `sdk.session.init` adoption leg (which already AWAIT-writes the binding row with `supersedes: old id`) re-keys the rollback row old→new inside the same awaited write batch, so there is still exactly one rollback-record-specific write and it always precedes the mutation. Provider failure AFTER a successful pre-write triggers a COMPENSATING rewrite of the pre-op record before the refusal is answered — but ONLY on legs where the provider PROVABLY rejected/unmoved (r3): a mutation-RPC error leg and (opencode) a SUCCESSFUL post-verify read whose pointer provably did not move compensate; a FAILED post-verify read leg (transport/5xx — the mutation may have applied) NEVER compensates: it answers `INTERNAL_ERROR` and KEEPS the ledger (the Task 3 triad governs; the next snapshot derives its prefix from provider rows, so pane + record reconverge automatically). So the ledger never describes a rollback the provider provably rejected, and is never rewritten to contradict a possibly-applied mutation. (The earlier draft's "reply success, then warn via a ledger-write-failed event" discipline is void and appears nowhere in this plan.)

## Load-bearing corrections (Stage 2, 2026-08-22 — VALIDATED)

All ten finder claims were settled by four validators (reports/load-bearing-validator-{A,B,C,desk}.md; ledger at `.worktrees/.the-usual-logs/freshagent-undo-redo/load-bearing-ledger.md`). The amendments below are binding on the tasks they name:

1. **Codex history-mode gate (LBC-1, verified).** `thread/revert` REFUSES legacy threads (`"thread/revert only supports paginated threads"`, -32600) and freshell starts every thread legacy today. Task 2 is amended: freshcodex `thread/start` calls SET `historyMode:"paginated"` and the freshell-side session record (`CodexSession`) gains `history_mode: Option<HistoryMode>` — `Some(Paginated)` for threads freshell started (we SET the mode at start); `thread/resume` takes no mode param, so resume/adoption reads the DURABLE mode (r3 amendment): the rollout's persisted `session_meta.history_mode` is parsed (validator-C proved the mode persists there; freshell-codex already reads rollouts for durability) and records `Some(Paginated)` when it says paginated — only a missing/unparseable durable mode stamps legacy (`None` ⇒ `undo:false`); a paginated thread created by this feature keeps undo capability across normal session rehydration. The app-server exposes no live mode read-back; the durable rollout meta (cached on the session record) is the source of truth. Rollback on a codex thread that is legacy (pre-existing back-catalog and any legacy start) is refused with `UNSUPPORTED_CAPABILITY` + the added pinned copy `CODEX_LEGACY_THREAD_COPY` = `Undo is unavailable for this session — it was started before conversation rollback support (codex threads created earlier use the legacy history format). Start a new session to undo.` (Out-of-scope: `codex migrate-rollouts --apply` back-catalog migration — follow-up kata.) Empty-prefix revert is LEGAL on codex (empties the thread; probe-verified) so codex has NO first-turn refusal. Codex mid-turn behavior (extra-1, verified): provider revert FORCE-INTERRUPTS then proceeds — the freshell busy gate is the sole mid-turn protection and its refusal test must assert the provider is never reached. Zero-turn paginated threads answer -32601 on read/includeTurns+turns/list (existing fallback covers).
2. **Opencode verified semantics (LBC-2, verified; one plan shape falsified → corrected).** Boundary is INCLUSIVE of the named message; assistant-message targets normalize to their parent user message (the icon acts on user turns anyway); unknown messageID is a silent 200 no-op (defense: post-revert verify read). The `revert` field lives top-level on the session body: `session.revert = {messageID, snapshot, diff, partID?}`, omitted entirely when no rollback is active — corrected wherever sample code nests it otherwise. The message LIST still returns the reverted tail without flags: freshell computes the active prefix strictly-before `revert.messageID`. Stepwise redo = re-revert at a later in-tail user message (verified); unrevert is all-or-nothing. Any subsequent send/command/summarize natively DELETES the reverted tail rows (matches decision 5; therefore the durable marker can only come from freshell's own ledger — never from opencode storage). **Binding correction:** native revert re-applies FILE state for patch-carrying turns (probe-verified). To keep "rollback never touches files" (decision 1 + accepted residual) true, Task 3 launches the freshopencode serve sidecar with opencode snapshots DISABLED in its managed config, and Task 7's opencode case proves byte-identical working tree after reverting a patch-carrying turn.
3. **Claude fork-at-point (LBC-3/4/8/9, verified with constraints).** Use ONLY the `query()` options lane (`{resume, resumeSessionAt, forkSession: true, resumeDropsTurn: <guard uuid>}`) — the standalone `forkSession()` fn remaps every uuid and is forbidden. `resumeSessionAt` keeps up-to-AND-including the named uuid over the RAW parentUuid chain (not the display list); the armed guard is mandatory, with the refusal-prefix `Resume rejected by --resume-drops-turn:` mapped to plain-resume recovery, and the plan's `resume_at_uuid` two-definition conflict is resolved to the raw-chain rule everywhere (the line-1774 display-predecessor variant is void). Task 4's claude `in_turn` busy truth CLEAR-SET is amended (LBC-10 falsified): clear on `sdk.result` (ANY subtype — a result frame ends the turn; the earlier "success-only" variant is void) AND `sdk.status:idle` AND sidecar EOF/death (`SIDECAR_EXITED`) AND after a completed `handle_interrupt` (interrupts yield no `result` at all) — no `sdk.error`/`compacting`/`assistant` edge, fail-closed otherwise (a missing arm wedges `BUSY_TURN` refusals forever). Claude redo validity contract (LBC-9): undo records `original_session_id` + `original_tip_uuid`; redo re-reads the chain-root original and loudly refuses `REDO_UNAVAILABLE` when the tip moved or the LCP no longer resolves (compaction/snips can relink/remove uuids). Claude transcript line comparison matches on `uuid`/`message` only and skips fork header/tail line kinds (`mode`, `atis-latch`, `queue-operation`, `last-prompt`). R2 amendment (fresh-eyes r2 F1): claude FIRST-TURN rollback is LEGAL — `resolve_resume_point` yielding `resume_at_uuid: None` means "before the first message"; the handler cancels pending cards, kills the sidecar, and creates a FRESH conversation (create with NO resume), recording the discarded session as the record's `original_session_id`/`original_tip_uuid` and adopting the fresh id through the existing sdk.session.init leg (cli_index + awaited binding + rollback-row re-key); `canRedo` = the original tip strictly beyond the live tip (none here); redo re-forks the original at THE LAST RAW-CHAIN UUID OF THE RESTORED FIRST STEP'S GROUP — its assistant tail (r3 boundary fix: `resumeSessionAt` keeps through-AND-including the named uuid, so redo of the `u1`/`a1` step resumes at `a1`, NOT `u1`; "the next turn's first uuid" formulations of this rule are void) — fork-at-point, the proved full-retention path — and adopts. `CLAUDE_FIRST_TURN_REFUSAL` is REMOVED; rollback to an empty conversation is uniformly legal across codex/opencode/claude.
4. **Version/refusal surface (LBC-5/6, verified).** No provider version gating exists anywhere today (PATH spawns via `CODEX_CMD`/`OPENCODE_CMD`/`CLAUDE_CMD`). Task 1 adds spawn-time version recording (logged at spawn; used to classify failures): codex `-32600 "thread/revert only supports paginated threads"` maps to `UNSUPPORTED_CAPABILITY` + `CODEX_LEGACY_THREAD_COPY` (item 1); codex unknown-method/`-32601` or a missing `thread/revert` shape maps to `UNSUPPORTED_CAPABILITY` + `CODEX_OLD_CLI_COPY`; an opencode revert-route 404/unknown route maps to `UNSUPPORTED_CAPABILITY` + `OPENCODE_OLD_CLI_COPY` (both pinned in the Wire Design copy list) — never an uncontextualized `INTERNAL_ERROR`; only unknown transport/other failures map to `INTERNAL_ERROR`. First-turn semantics per provider (r2-corrected): ALL providers legally roll back to an empty conversation — codex/opencode empty the prefix in place; claude/kilroy take the item-3 fresh-conversation path (the discarded session is retained for redo). The earlier "claude structurally refuses" rule is void.
5. **Refusal codes final set:** `UNSUPPORTED_CAPABILITY` (unsupported provider/op; codex redo permanently; old-CLI; legacy codex thread) · `INVALID_SESSION_ID` · `BUSY_TURN` · `INVALID_ROLLBACK_TARGET` (missing/unknown turnId; r2: NO first-turn case for any provider) · `NOTHING_TO_UNDO` · `REDO_UNAVAILABLE` (codex always — paired with `REDO_CODEX_UNSUPPORTED_NOTICE`; claude moved-tip) · `INTERNAL_ERROR` (unknown failures). Task 1's W2 refusal matrix is amended accordingly (Task 5 stamps capabilities accordingly — codex `{undo:true(paginated-only), redo:false}`).

Self-review over the corrected sections: User Request block unchanged; corrections map one-to-one onto Tasks 1, 2, 3, 4, 5 and the coverage table rows they amend; no new placeholders; verdict PASS. Keeper note: evidence lives in the validator reports only; this section records decisions.

R1 remediation self-review (fresh-eyes round 1, 2026-08-22 — over ONLY the r1-changed sections): the User Request block is byte-identical; all eleven major and three minor findings are fixed at their named loci — Task 1 (record-write discipline is durable-BEFORE-mutation with `LEDGER_WRITE_REFUSAL_COPY` refusal and compensating rewrite; `RollbackRecord` gains the stored `can_redo` bit + `original_tip_uuid`; per-provider old-CLI copies pinned; the codex catalog is capability-filtered; every multi-filter cargo command split; the contract-cleanliness check moved post-commit), Task 2 (record pre-write precedes `thread/revert`; three-way error mapping), Task 3 (per-session mutex held across the whole handler + `handle_send` consults `rollback_in_flight`, pinned semantic "send waits, rollback wins, then destroys"; top-level `session.revert` reads and a fake that never hides the tail; post-verify re-read + 404→`OPENCODE_OLD_CLI_COPY`; conversation-order marker bucket; snapshots-disabled managed serve launch), Task 4 (`original_tip_uuid` stored at undo + tip/LCP redo validation with `REDO_REMOVED_HISTORY_COPY`; raw-`parentUuid`-chain resolver everywhere; `resumeDropsTurn` guard + refusal-prefix plain-resume recovery; exactly-four-edge busy clear-set, fail-closed), Task 5 (session-scoped codex stamps — no hard-coded `"undo": true`; stored-bit + tip-rechecked claude canRedo), Task 6 (server `message` rendered verbatim; direction-correct busy copy; no codex /redo affordance), Task 7 (patch-carrying turn with byte-identical tree assertion; double-undo marker-order assertion; fake serves the tail unflagged). Cross-refs between the wire-design record semantics and the per-provider tasks re-pointed; no placeholders introduced; the Stage-2 corrections section above stays as the decision record (item 4 now names the per-provider pinned copy constants). Verdict PASS.

R2 remediation notes (fresh-eyes round 2, 2026-08-23 — all Major findings adjudicated SUBSTANTIATED; the Minor per-marker "Redo to here" finding adjudicated UNSUBSTANTIATED via the owner's "redo works in that case too" icon-path decision, kata decision 3 — that affordance stays):
1. Claude first-turn undo is now LEGAL (replaces the `INVALID_ROLLBACK_TARGET` first-turn refusal; `CLAUDE_FIRST_TURN_REFUSAL` removed): `resume_at_uuid: None` = "before the first message" → pending-cancel frames, sidecar kill, FRESH conversation (no resume), discarded session recorded as `original_session_id`/`original_tip_uuid`, adoption via sdk.session.init incl. rollback-row re-key; redo re-forks the original (the "first user-anchor uuid" target this note originally stated is SUPERSEDED by R3 note 4: the resume point is the LAST raw-chain uuid of the restored step's group — its assistant tail: redo of the `u1`/`a1` step resumes at `a1`). Also SUPERSEDED by R3 note 1: "Task 5 claude bucket variant" now sources markers from ledger `entries` (union), not the read-time LCP alone (correction item 3 above; Task 4 handler/tests/integration; Task 5 claude bucket variant).
2. Serialization lock discipline (Tasks 2/3/4): ONE per-session async turn lock per provider lane, held across the whole rollback handler (busy-check → reads → provider mutation → post-verify → record write → reply); lock order when the two primitives co-occur = `rollback_in_flight` FIRST, then the turn lock; `handle_send` NEVER acquires/consults `rollback_in_flight` (a live send simply waits on the turn lock behind a rollback, then proceeds and destroys redo — no circular wait, no deadlock); codex/claude sends set their busy truth UNDER the same turn lock BEFORE writing to the provider (check-then-set window closed); the concurrency test asserts deterministic serialization + bounded completion.
3. Epoch reset across submissions (Tasks 2/3/4 + wire-design record semantics): a new undo while `redo_destroyed` starts a NEW epoch — `redo_destroyed` cleared, claude re-roots `original_session_id`/tip to the CURRENT durable id; `destroy_redo_on_submit` keeps destroying redo on every submission; new unit tests pin undo→send→undo↔redo per lane. (The marker half of this note — "entries cleared", "codex restarts its entries list", "opencode rebuilds the bucket from the provider tail only", "old-epoch markers leave the LIVE marker display... while durable transcript browsing still shows provider-stored rows" — is SUPERSEDED by R3 note 1: markers are the ledger-entries UNION of every epoch, never dropped; only the redo-capable chain state resets per epoch. Codex thread/revert destroys the tail and opencode deletes it on next send, so provider storage cannot carry old-epoch markers.)
4. The opencode snapshot builder change is NO LONGER a pure refactor: after extracting `opencode_message_turn_json`, `build_opencode_snapshot_json` gains the FUNCTIONAL filter — `turns[]` = the active prefix (messages strictly before top-level `session.revert.messageID`; no `info.revert` exists) and the unflagged tail rows become `rolledBackTurns` markers in conversation order; tests pin the middle-message revert + stable order across repeated undos; the Task 7 fake keeps serving the tail unflagged (cross-check).
5. `/undo` and `/redo` are RESERVED slash names (Tasks 1/6): capability-false (freshcodex `/redo`, legacy caps) answers with the pinned `REDO_CODEX_UNSUPPORTED_NOTICE`/`rollbackUnsupportedNotice` and never sends text to the model; the catalog MENU still hides capability-false entries (r1 F2 stays); Task 6 tests pin menu-absence + typed-`/redo`-yields-notice + no send; the codex e2e expectation (typed `/redo` → notice) is unchanged and consistent. (The seam named here — "`runSlashCommand` intercepts them BEFORE the fallback-to-text path" — is SUPERSEDED by R3 note 8: runSlashCommand only ever sees catalog-RESOLVED commands, so the interception lives in the COMPOSER's submit path pre-catalog-resolution.)
6. Codex history-mode persistence (Tasks 2/5): `CodexSession` gains `history_mode: Option<HistoryMode>` — `Some(Paginated)` recorded at start for threads freshell starts; the capability stamp is `undo ⟺ Some(Paginated)`; the runtime `-32600` mapping stays as belt (a thread paginated externally... legacy copy on refusal); live read-back of a mode is not exposed by the app-server. (The "resumed/adopted threads record `None` (unknown ⇒ legacy stamps) ... session record is the SoT" half of this note is SUPERSEDED by R3 note 2: resume/adoption parses the rollout's persisted `session_meta.history_mode` — validator-C proved the mode persists there — so only a missing/unparseable mode stamps legacy; a paginated thread survives rehydration with undo capability intact.)
7. Task 7's double-undo assertion now filters marker summaries to user-role rows before comparing to the two prompts (marker ROWS include assistant rows; one undone step = two rows); Task 6's `Rolled back (N)` label counts rollback STEPS (user-role marker groups), not raw rows.
8. Task 7's provider matrix gains a KILROY e2e case (seven tests): a `sessionType=kilroy` pane on the claude lane drives typed `/undo` dispatch → fork-at-point create with a minted new id → refill + marker, reusing the freshclaude fake sidecar with kilroy config.
9. Claude busy clear-set contradiction deleted: the four clear edges are `sdk.result` (ANY subtype), `sdk.status:idle`, sidecar EOF/`SIDECAR_EXITED`, completed `handle_interrupt`; the file-summary `sdk.error` mention is removed; the enumerated test also asserts `sdk.error`/`compacting`/`assistant` never clear (fail-closed).
10. SDK version note corrected: the sidecar's OWN lockfile pins `@anthropic-ai/claude-agent-sdk` 0.3.237 while repo-level `node_modules` materializes 0.3.235 — Task 4 cites both; the observed `query()` options exist in each.

R2 remediation self-review (re-run over ONLY the r2-changed sections): the User Request block is byte-identical; each of the ten adjudicated corrections is applied at its locus with code samples, tests, and Steps kept mutually consistent (one per-session turn lock named uniformly across the three lanes; `resume_at_uuid: Option<String>` threaded through Task 4's resolver, handler tuple, spawn legs, and redo target rule; epoch rule stated once in the wire design and applied identically in all three handlers + tests; reserved-name rule stated once in Task 6 with Task 1's menu filtering untouched; F11 left unchanged per the UNSUBSTANTIATED adjudication); no new placeholders; verdict PASS.

R3 remediation notes (fresh-eyes round 3, 2026-08-23 — all eight findings adjudicated SUBSTANTIATED; each correction applied at its loci and cross-referenced SUPERSEDED where it replaces r2 text):

1. **Markers accumulate; epochs reset only redo state.** The r2 epoch rule's marker half is replaced everywhere it appeared: `entries` is the UNION of every epoch's rolled-back turns (frozen prior-epoch markers first, in original conversation order), durable in the ledger even after native provider deletion (codex `thread/revert` destroys the tail; opencode deletes it on the next send — only the ledger satisfies decision 6's "persist marked", while decision 5's submission-destroy kills ONLY redo). An epoch reset clears ONLY the redo-capable chain state: `redo_destroyed` clears so the record's redo fields describe the NEW chain (the prior chain's redo stays permanently dead — its provider tail no longer exists), and the per-epoch chain root is replaced at the new undo (claude re-roots as r2 specified; opencode retargets the serve pointer; codex n/a). Amended: wire-design record semantics (codex/opencode/claude bullets + the epochs bullet) and the storage-discipline paragraph; Task 2 (epoch comment + codex epoch test now asserts the two-entry union); Task 3 (amendment bullet, undo-branch union rebuild code + epoch comment, the resend epoch test); Task 4 (epoch test asserts union markers + re-rooted chain state; the handler's record write merges the union — undo splices the slice in conversation position, redo drops restored ids from the current-epoch portion); Task 5 (`rolledBackTurns` sourced from ledger `entries` on ALL three lanes; current-epoch redo state — claude tip/LCP recheck, opencode pointer — stays chain-root-driven).
2. **Codex history-mode durably readable.** `CodexSession.history_mode` is filled at `thread/start` (`Some(Paginated)` — we SET the mode) AND at resume/adoption by parsing the rollout's persisted `session_meta.history_mode` (validator-C proved the mode persists there; freshell-codex already reads rollouts for durability). "Resumed/adopted ⇒ `None` ⇒ legacy" is no longer a permanent verdict — ONLY a missing/unparseable durable mode stamps legacy (`undo:false`), so a paginated thread keeps undo capability across normal session rehydration. Amended IN PLACE: correction item 1's verdict sentence, the wire-design stamp parenthetical, R2 note 6 (supersede marker), Task 2's amendment bullet + constructor text (plus a new `resume_parses_the_rollouts_durable_history_mode` test), and Task 5's amendment bullet + codex builder text.
3. **Opencode post-verify failure triads.** Never a compensating rewrite after a possibly-applied mutation. The post-revert read classifies as: (a) pointer observed == the requested boundary (or absent after a full unrevert) ⇒ success; (b) read SUCCEEDED and the pointer provably unchanged (record reads fine, pointer mismatch — the verified silent-200 rule is pointer-untouched-on-no-op, so the provider is provably unmoved) ⇒ `INVALID_ROLLBACK_TARGET` + compensating rewrite; (c) the read ITSELF FAILED (transport/5xx) ⇒ `INTERNAL_ERROR`, the ledger is KEPT, and the retry-conciliation note: the next snapshot derives the prefix from provider rows, so pane + record reconverge automatically. Applied to BOTH the undo and redo legs; the old `.await.ok()`-flattened classification is replaced by an explicit `match` on the read `Result`; new test `handle_rollback_post_verify_READ_failure_keeps_the_ledger_and_reports_internal_error` pins leg (c) on both directions; the silent-noop test comment re-names leg (b); the mutation-RPC-error legs (404/5xx from revert itself) provably did not apply and still compensate.
4. **Claude redo boundary math.** Redo-through-target's resume point = THE LAST chain uuid belonging to the target turn's raw-chain group (its assistant tail), never the next turn's first: `resumeSessionAt` keeps through-AND-including the named uuid, so redo of the `u1`/`a1` step resumes at `a1` (undo→redo is invertible; resuming at `u1` would restore only the bare prompt). Amended: the first-turn integration test's redo expectation (`resumeSessionAt == a1`), the `redo_resume_target` helper test list (empty-current case → `a1`), the handler's Redo-branch comment, the None-leg comment, correction item 3's R2 amendment sentence, and the R2 note 1 (supersede marker).
5. **`undoneDepth` = user-step count of the marker bucket.** `rollback.undoneDepth` is the count of USER-role turns in the `rolledBackTurns` bucket (the currently rolled-back step set — the redoable set in the single-epoch case), NEVER `entries.len()` (a rebuilt single-entry tail over `[u2,a2,u3,a3]` yields 2, not 1). The client's `Rolled back (N)` label uses the same user-step count of the same bucket. Amended: Task 5 codex + opencode builder text (both `entries.len()` formulations deleted); Task 5 opencode test gains the two-step-undo `undoneDepth == 2` variant; the claude rule already counted user turns and now reads the entries-sourced bucket; Task 6 label comment ties the two counts.
6. **Task 6 red-phase commands.** Step 1 now writes the `FreshAgentTranscript.test.tsx` (rolled-back section render, user-step label, redo-to-here rows) AND `FreshAgentView.test.tsx` (slash dispatch + reserved-seam + verbatim server message) coverage alongside the other suites, and Step 2's command runs BOTH files (plus the pre-existing five), so every stated Step-2 failure is reachable pre-implementation; Step 2's Expected text names the transcript/view failure modes explicitly.
7. **Attention revocation is pane-scoped.** `revokeFreshAgentAttention` clears ONLY the rolled-back pane's attention entry, then re-derives tab-level green as the OR over the tab's REMAINING panes (`attentionByPane` over the tab's layout, minus the revoked pane) — never a blanket tab clear when a sibling pane still holds attention. The Task 6 test pins a same-tab SIBLING pane's attention (and the derived tab flag) surviving a rollback, plus a single-pane-tab clear variant; the stranger-tab check stays.
8. **Reserved-command interception seam.** `/undo` and `/redo` interception lives in the COMPOSER's submit path (`sendText`, before `parseSlashCommand`-driven catalog resolution and before any `onSend` fallthrough) via the new `onReservedRollbackCommand` prop — `runSlashCommand` only executes catalog-RESOLVED commands, and the catalog omits capability-false ones, so an in-`runSlashCommand` intercept could never fire for them (the draft's `commandInput` reference is deleted — it had no such variable in scope and could not compile). The view supplies the pinned-notice routing (`REDO_CODEX_UNSUPPORTED_NOTICE` for codex `/redo`; `rollbackUnsupportedNotice` otherwise); `shared/fresh-agent-slash-commands.ts` exports `RESERVED_ROLLBACK_SLASH_NAMES` (Task 1). Tests: composer-level (typed `/redo` unresolvable ⇒ `onReservedRollbackCommand('redo')`, `onSend` never called; resolvable ⇒ normal command path) and view-level (typed `/redo` on a freshcodex pane ⇒ the pinned codex notice, no send) per corrections 6/8; the codex e2e expectation is unchanged.

R3 remediation self-review PASS (fresh-eyes round 3, 2026-08-23 — over ONLY the r3-changed sections): the "## User Request" block is byte-identical; all eight adjudicated findings are fixed at their named loci with Tasks 1/2/3/4/5 code, tests, and Steps kept mutually consistent (one union-marker rule stated once in the wire design and applied identically across the three providers' handlers + snapshot sourcing; one codex history-mode durability rule across the stamp-emitting sites; one opencode post-verify triad across interface bullet, code legs, and tests; one claude redo boundary rule with no residual "first user-anchor uuid" resume targets; `undoneDepth` user-step-counted at every stamp site and matched by the label; the reserved-name seam pinned at the composer with `runSlashCommand`-only interception deleted); red-phase commands are runnable and list every suite whose failure is claimed; pinned copies referenced (`REDO_CODEX_UNSUPPORTED_NOTICE`, `rollbackUnsupportedNotice`, `LEDGER_WRITE_REFUSAL_COPY`, `OPENCODE_OLD_CLI_COPY`, `REDO_REMOVED_HISTORY_COPY`, `RESERVED_ROLLBACK_SLASH_NAMES`) exist in the plan's pinned-copy/code sections. The plan-review loop verdict stays recorded: FAILED / NON-CONVERGED — the 3-round cap is reached (3/3), the loop closes here, and independent verification continues in the Stage-5 delta review.

## Load-bearing assumptions for Stage-2 validation (re-verify before/alongside Task 1)

(S2 RESULT: all five rows were validated and are now settled — see "Load-bearing corrections" above; this list is kept for historical traceability only.)

1. **LB-1** — codex 0.149.0 `thread/revert{threadId, beforeTurnId}` wire name/params and keep-prefix-BEFORE-the-turn semantics (kata verified 2026-08-22; probe again with a real app-server before finalizing Task 2's client method).
2. **LB-2** — opencode 1.18.21: (a) `GET /session/:id/message` behavior for reverted messages (included+flagged vs excluded — the handler must compute the active prefix itself from `session.revert.messageID` if excluded-or-not is ambiguous); (b) a revert/unrevert updates `session` info `revert` field; (c) a new `prompt_async` after a revert supersedes/destroys the revert pointer (decision 5 belt under our freshell-side destroyed bit).
3. **LB-3** — `@anthropic-ai/claude-agent-sdk` `query()` options accept `resumeSessionAt` (message-uuid target, keep-up-to-and-including semantics) and `forkSession: true` (mints a NEW durable session id while the original's JSONL is untouched).
4. **LB-4** — Claude forked transcripts preserve original message `uuid`s for prefix lines (the claude LCP marker computation depends on it; if false, Stage 2 switches LCP to role+text matching before Task 4 proceeds).
5. **LB-5** — (SUPERSEDED by the r2 fresh-eyes remediation: first-turn rollback is LEGAL via the fresh-conversation path — see correction item 3's R2 amendment and Task 4. Kept for historical traceability.) Claude rollback cannot express "before the first message" (no parent uuid): Step on a 1-turn history and toTurn on the first user turn are refused with `INVALID_ROLLBACK_TARGET` (`Cannot roll back past the first message — start a new conversation instead.`). This was the then-chosen v1 edge behavior; Stage 2 confirmed the SDK offers no empty-fork primitive.

## Plan notes (not tasks)

- The legacy TS server is untouched (kata z04y). No REST twin of rollback exists in v1 (WS-only per the kata's entry points); if the agent-API/MCP surface later needs rollback it lands in `crates/freshell-freshagent`, never `server/agent-api/router.ts`.
- Accept-and-strip means old Rust builds ignore `freshAgent.undo`/`redo` frames (typed parse fails closed, no dispatch); the version bump makes cross-version clients reconnect-reload instead of half-speaking.
- The kata `s2rk` same-id divergence in the e2e claude fake (a resumed create keeps the same cliSessionId; real claude `--fork-session` mints a fresh one) is corrected as one explicit step in Task 7's fake extension.

---

### Task 1: Rollback wire contract, durable rollback-record plumbing, and the refusal surface

**Files:**
- Modify: `shared/ws-protocol.ts` (new `FreshAgentUndoSchema`/`FreshAgentRedoSchema`; register in `FreshAgentClientMessageSchema` and `ClientMessageSchema`; insert after `FreshAgentForkSchema`)
- Modify: `shared/ws-version.ts:1` (`WS_PROTOCOL_VERSION` 7 → 8)
- Modify: `shared/fresh-agent-contract.ts:14-23` (`undo`/`redo` optional booleans), `:164-175` (`rolledBack` optional), `:230-246` (`rolledBackTurns` + inline `rollback` block, both optional)
- Modify: `shared/fresh-agent-slash-commands.ts` (`FreshAgentSlashCommandAction` gains `'undo' | 'redo'`; `BASE_COMMANDS` gains the two entries, no aliases)
- Regenerate (commit in same commit): `port/contract/ws-protocol.schema.json`, `port/contract/ws-message-inventory.json`, `port/contract/ws-server-messages.schema.json`
- Modify: `crates/freshell-protocol/src/lib.rs:37` (const → 8 + module doc), `src/common.rs:5` (stale version doc)
- Modify: `crates/freshell-protocol/src/client_messages.rs` (`RollbackMode` enum + `FreshAgentUndo`/`FreshAgentRedo` structs + two `ClientMessage` arms + `CLIENT_MESSAGE_TYPES: [&str; 33]` with `"freshAgent.redo"` and `"freshAgent.undo"` inserted alphabetically)
- Modify: `crates/freshell-protocol/tests/inventory.rs` (31→33, `combined_surface_is_89`→91 and rename to `_is_91`)
- Modify: `crates/freshell-protocol/tests/version.rs:26,67` (7→8, stale comment line)
- Modify: `crates/freshell-protocol/tests/pane_reconcile.rs:7,21,41` (literals → `freshell_protocol::WS_PROTOCOL_VERSION`; refresh the stale §4.5 comment)
- Modify: `crates/freshell-server/tests/safe11_term22_shutdown_reaping.rs:312` (7 → `freshell_protocol::WS_PROTOCOL_VERSION`)
- Modify: `crates/freshell-ws/src/lib.rs:947,954` (test literals 7 → 8; the v6-rejection literal at :940 stays 6)
- Modify: `crates/freshell-ws/src/terminal.rs` (rollback refusal helper + two new `ClientMessage` dispatch arms answering it; refusal runs ON the requesting connection via `conn_sink`)
- Create: `crates/freshell-freshagent/src/rollback_record.rs` (`RollbackRecord`/`RollbackEntry`/`RollbackDirection`/`RollbackModeReq`/`RollbackRequest` + pinned message consts + frame builders)
- Modify: `crates/freshell-freshagent/src/identity_sink.rs` (trait gains `record_rollback`/`load_rollback`; `FakeIdentitySink` implements)
- Modify: `crates/freshell-freshagent/src/lib.rs` (`pub mod rollback_record;` + re-exports) and `crates/freshell-freshagent/src/identity_sink.rs` doc
- Modify: `crates/freshell-ws/src/pane_ledger.rs` + `crates/freshell-ws/src/pane_ledger_scan.rs` (third row kind `rollback/<enc(provider)>/<enc(sessionId)>.json` + write-through `rollback_index`; boot scan populates it; corruption quarantines per-row)
- Modify: `crates/freshell-server/src/identity_sink.rs` (`LedgerIdentitySink` rollback impl over the ledger)
- Modify version literals 7 → 8 in: `test/e2e-browser/helpers/ws-capture.ts:21`, `test/e2e-browser/specs/{freshagent-settings-resume-rust,codex-status-completeness-rust,leak-metrics,create-protection-isolation-rust,reconcile-handshake-rust,amplifier-lane-resilience-rust,rest-spawn-gate-rust,fresh-agent-control-rust,terminal-activity-rust}.spec.ts`, `test/unit/port/normalize.test.ts:58,250` (import `WS_PROTOCOL_VERSION` there instead of a literal)
- Test: `test/server/ws-protocol.test.ts` (append), `test/unit/shared/fresh-agent-contract.test.ts` (append), `test/unit/shared/fresh-agent-slash-commands.test.ts` (append), `crates/freshell-ws/tests/freshagent_rollback_refusal.rs` (create)

**Interfaces:**
- Consumes: existing union registrations (`shared/ws-protocol.ts:604-614, 700-732`), `FrameSink` answering idiom (`crates/freshell-ws/src/terminal.rs:1163-1180`), refusal parity-text shape (`terminal.rs:4814-4890`), `PaneIdentitySink` trait + `FakeIdentitySink` (`crates/freshell-freshagent/src/identity_sink.rs`), `PaneLedger` (`crates/freshell-ws/src/pane_ledger.rs`), `LedgerIdentitySink` (`crates/freshell-server/src/identity_sink.rs:30-114`).
- Produces:
  - `FreshAgentUndoSchema` / `FreshAgentRedoSchema` (zod; also exported types). Frames: `{type, requestId:string, sessionId, sessionType, provider, cwd?, mode?: 'step'|'toTurn', turnId?}`.
  - `freshell_protocol::FreshAgentUndo` / `FreshAgentRedo` serde structs; `RollbackMode` enum (`#[serde(rename_all = "camelCase")] Step | ToTurn`).
  - `RollbackRecord` / `RollbackEntry` / `RollbackRequest`/`RollbackDirection`/`RollbackModeReq` in `rollback_record.rs` (Wire Design has the record schema):
    ```rust
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum RollbackDirection { Undo, Redo }
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum RollbackModeReq { Step, ToTurn }
    /// Wall-clock ms — every op (rollback, redo, destroy) stamps/at_ms with it.
    pub fn now_ms() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }
    pub struct RollbackRequest {
        pub direction: RollbackDirection,
        pub mode: RollbackModeReq,
        pub turn_id: Option<String>,
        pub session_id: String,
        pub session_type: SessionType,
        pub provider: AgentProvider,
        pub request_id: String,
        pub cwd: Option<String>,
    }
    impl RollbackRequest { pub fn from_undo(m: FreshAgentUndo) -> Self; pub fn from_redo(m: FreshAgentRedo) -> Self; }
    pub const ROLLBACK_BUSY_MESSAGE: &str = "Rollback is not supported while a turn is running — queue a steer message or wait for the turn to finish.";
    pub const REDO_DESTROYED_MESSAGE: &str = "Redo is no longer available — a message submitted after the undo permanently retired it.";
    pub const REDO_EMPTY_MESSAGE: &str = "Nothing to redo.";
    pub const UNDO_EMPTY_MESSAGE: &str = "Nothing to roll back.";
    pub const LEDGER_WRITE_REFUSAL_COPY: &str = "Undo is unavailable right now — the rollback record could not be saved. Try again.";
    pub const CODEX_OLD_CLI_COPY: &str = "Rollback requires a newer Codex CLI (codex ≥0.149). Check the freshcodex sidecar logs for the exact error.";
    pub const OPENCODE_OLD_CLI_COPY: &str = "Rollback requires a newer OpenCode CLI (opencode ≥1.18). Check the serve logs for the exact error.";
    pub const REDO_REMOVED_HISTORY_COPY: &str = "Redo is no longer available — the original conversation's history changed since the undo.";
    /// freshAgent.event{freshAgent.error{code,message,requestId,rollback:true}} stamped from `op`.
    pub fn rollback_error_frame(op: &RollbackRequest, code: &str, message: &str) -> ServerMessage;
    /// freshAgent.event{freshAgent.rolledBack|freshAgent.redone{...ack fields...}} for the requesting sink.
    pub fn rollback_ack_frame(op: &RollbackRequest, live_session_id: &str, removed_prompt_text: Option<&str>, removed_turn_ids: &[String], can_redo: bool, new_session_id: Option<&str>) -> ServerMessage;
    /// freshAgent.event{freshAgent.session.rolledBack|.redone{..., revokeAttention on undo}} for the broadcast bus.
    pub fn rollback_broadcast_frame(op: &RollbackRequest, live_session_id: &str, removed_turn_ids: &[String], can_redo: bool) -> ServerMessage;
    impl RollbackRecord {
        pub fn empty(now_ms: i64) -> Self; // can_redo: false, original_tip_uuid: None
        /// The STORED bit only — never entries-derived (claude keeps entries empty by design).
        pub fn can_redo(&self) -> bool;
        /// Stamps the stored bit + lifts last_op_at_ms. Provider handlers compute the value
        /// per the record semantics above and write it at op time.
        pub fn set_can_redo(&mut self, value: bool, now_ms: i64);
        /// Decision 5: sets redo_destroyed AND clears the stored can_redo bit; markers survive.
        pub fn destroy_redo(&mut self, now_ms: i64);
        pub fn push_entry(&mut self, entry: RollbackEntry, now_ms: i64);
    }
    ```
  - `PaneIdentitySink::record_rollback(provider, session_id, record) -> SinkWrite` and `PaneIdentitySink::load_rollback(provider, session_id) -> Option<RollbackRecord>` (entries filters `record.version != ROLLBACK_RECORD_VERSION` to `None`).
  - `PaneLedger::record_rollback_row(provider, session_id, payload: &serde_json::Value, now_ms: i64) -> io::Result<()>` and `PaneLedger::load_rollback_row(provider, session_id) -> Option<Value>`.
  - `terminal.rs` rollback dispatch arms (Task 1: every provider×op refuses on the requesting sink; Tasks 2–4 replace per-provider).

- [ ] **Step 1: Write the failing behavioral test**

All of the following are written together, run together, then the implementation lands (one red-green cycle for the contract layer):

`test/server/ws-protocol.test.ts` — append:

```ts
import { ClientMessageSchema } from '../../shared/ws-protocol.js' // verify against existing import at the top of this file

describe('freshAgent.undo / freshAgent.redo frames (kata 1wxv)', () => {
  const base = { sessionId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', requestId: 'rb-1' }
  it('accepts an undo frame with mode omitted (step default)', () => {
    expect(ClientMessageSchema.safeParse({ ...base, type: 'freshAgent.undo' }).success).toBe(true)
  })
  it('accepts a toTurn redo frame carrying turnId', () => {
    expect(ClientMessageSchema.safeParse({ ...base, type: 'freshAgent.redo', mode: 'toTurn', turnId: 'msg_x1' }).success).toBe(true)
  })
  it('rejects an unknown mode', () => {
    expect(ClientMessageSchema.safeParse({ ...base, type: 'freshAgent.undo', mode: 'all' }).success).toBe(false)
  })
  it('rejects a missing requestId (ack correlation is mandatory)', () => {
    const { requestId: _drop, ...noReq } = base as Record<string, unknown>
    expect(ClientMessageSchema.safeParse({ ...noReq, type: 'freshAgent.undo' }).success).toBe(false)
  })
})
```

`test/unit/shared/fresh-agent-contract.test.ts` — append:

```ts
describe('rollback surface (kata 1wxv)', () => {
  it('capabilities accept optional undo/redo keys and stay strict', () => {
    const parsed = FreshAgentCapabilitiesSchema.safeParse({
      send: true, interrupt: true, approvals: false, questions: false, fork: false, undo: true, redo: false,
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.undo).toBe(true)
    expect(parsed.data?.redo).toBe(false)
  })
  it('capabilities without the new keys still parse (legacy TS server never emits them)', () => {
    expect(FreshAgentCapabilitiesSchema.safeParse({
      send: true, interrupt: true, approvals: false, questions: false, fork: false,
    }).success).toBe(true)
  })
  it('a turn may carry rolledBack', () => {
    const parsed = FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: 's', items: [{ id: 'i1', kind: 'text', text: 'hi' }], rolledBack: true,
    })
    expect(parsed.success).toBe(true)
  })
  it('snapshot accepts rolledBackTurns + the inline rollback block', () => {
    const turn = { id: 't2', turnId: 't2', summary: 'gone', items: [], rolledBack: true }
    const parsed = FreshAgentSnapshotSchema.safeParse({
      sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_1',
      revision: 3, status: 'idle',
      capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true, undo: true, redo: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turns: [], rolledBackTurns: [turn], rollback: { canRedo: true, undoneDepth: 1 },
      extensions: {},
    })
    expect(parsed.success).toBe(true)
  })
  it('snapshot remains strict against undeclared keys', () => {
    const parsed = FreshAgentSnapshotSchema.safeParse({
      sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_1',
      revision: 3, status: 'idle',
      capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turns: [], extensions: {}, rollbackTypo: {},
    })
    expect(parsed.success).toBe(false)
  })
})
```

`test/unit/shared/fresh-agent-slash-commands.test.ts` — append:

```ts
describe('fresh-agent slash commands: /undo + /redo (kata 1wxv decision 8)', () => {
  it('registers /undo for every session type, with no aliases', () => {
    for (const sessionType of ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'] as const) {
      const undo = getFreshAgentSlashCommands(sessionType).find((c) => c.name === 'undo')
      expect(undo?.action).toBe('undo')
      expect(undo?.aliases).toBeUndefined()
    }
  })
  it('registers /redo for claude/opencode session types only — freshcodex is undo-only (decision 5: no redo affordance appears, never "show then reject")', () => {
    for (const sessionType of ['freshclaude', 'kilroy', 'freshopencode'] as const) {
      const redo = getFreshAgentSlashCommands(sessionType).find((c) => c.name === 'redo')
      expect(redo?.action).toBe('redo')
      expect(redo?.aliases).toBeUndefined()
    }
    expect(getFreshAgentSlashCommands('freshcodex').find((c) => c.name === 'redo')).toBeUndefined()
    expect(resolveFreshAgentSlashCommand('freshcodex', '/redo')?.action).not.toBe('redo')
  })
  it('resolves both commands where registered', () => {
    expect(resolveFreshAgentSlashCommand('freshclaude', '/undo')?.action).toBe('undo')
    expect(resolveFreshAgentSlashCommand('freshopencode', 'redo')?.action).toBe('redo')
  })
  // Reserved names (r2; seam corrected r3 correction 8): the CATALOG filtering above only
  // governs the menu. /undo and /redo are additionally reserved at the COMPOSER's submit
  // path (pre-catalog-resolution — a seam runSlashCommand could never provide, since the
  // filtered catalog omits capability-false commands and unresolved names fall through to
  // model text), so a TYPED '/redo' on freshcodex is intercepted with the pinned notice
  // instead of falling through to the model — the composer/view-level tests live in Task 6.
})
```

`crates/freshell-ws/tests/freshagent_rollback_refusal.rs` — create:

```rust
//! Kata 1wxv Task 1: `freshAgent.undo` / `freshAgent.redo` land contract-first —
//! until each provider leg (Tasks 2-4) replaces its refusal with a real dispatch,
//! every provider x op cell is answered ON THE REQUESTING CONNECTION with the
//! nested `freshAgent.error{UNSUPPORTED_CAPABILITY}` shape stamped `rollback:true`
//! and echoing `requestId` (so the initiating pane routes the rejection to its
//! notice banner instead of the pane error surface). Codex x redo is refused
//! PERMANENTLY (decision 5); amplifier x op cells are refused permanently
//! (no amplifier fresh-agent runtime exists). Harness: `freshagent_control_reply.rs`.

mod common;
use common::*;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message as WsMessage;

async fn send_json(ws: &mut TestWs, value: serde_json::Value) {
    ws.send(WsMessage::Text(value.to_string()))
        .await
        .expect("send rollback frame");
}

fn assert_rollback_refusal(
    frame: &serde_json::Value,
    session_id: &str,
    provider: &str,
    session_type: &str,
    request_id: &str,
    message: &str,
) {
    assert_eq!(frame["type"], serde_json::json!("freshAgent.event"), "{frame}");
    assert_eq!(frame["provider"], serde_json::json!(provider), "{frame}");
    assert_eq!(frame["sessionId"], serde_json::json!(session_id), "{frame}");
    assert_eq!(frame["sessionType"], serde_json::json!(session_type), "{frame}");
    assert_eq!(frame["event"]["type"], serde_json::json!("freshAgent.error"), "{frame}");
    assert_eq!(frame["event"]["code"], serde_json::json!("UNSUPPORTED_CAPABILITY"), "{frame}");
    assert_eq!(frame["event"]["message"], serde_json::json!(message), "{frame}");
    assert_eq!(frame["event"]["requestId"], serde_json::json!(request_id), "{frame}");
    assert_eq!(frame["event"]["rollback"], serde_json::json!(true), "{frame}");
}

#[tokio::test]
async fn undo_is_refused_for_every_provider_until_its_leg_lands() {
    let (url, _registry) = spawn_server().await;
    for (provider, session_type) in [
        ("claude", "freshclaude"),
        ("claude", "kilroy"),
        ("codex", "freshcodex"),
        ("opencode", "freshopencode"),
    ] {
        let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
        send_json(&mut ws, serde_json::json!({
            "type": "freshAgent.undo", "provider": provider, "sessionId": "s-rb",
            "sessionType": session_type, "requestId": "rb-u-1",
        })).await;
        let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
        assert_rollback_refusal(
            &frame, "s-rb", provider, session_type, "rb-u-1",
            &format!("Undo is not supported for {session_type}"),
        );
    }
}

#[tokio::test]
async fn redo_is_refused_for_every_provider_until_its_leg_lands() {
    let (url, _registry) = spawn_server().await;
    for (provider, session_type) in [
        ("claude", "freshclaude"),
        ("claude", "kilroy"),
        ("codex", "freshcodex"),
        ("opencode", "freshopencode"),
    ] {
        let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
        send_json(&mut ws, serde_json::json!({
            "type": "freshAgent.redo", "provider": provider, "sessionId": "s-rb",
            "sessionType": session_type, "requestId": "rb-r-1", "mode": "step",
        })).await;
        let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
        assert_rollback_refusal(
            &frame, "s-rb", provider, session_type, "rb-r-1",
            &format!("Redo is not supported for {session_type}"),
        );
    }
}
```

`crates/freshell-freshagent/src/rollback_record.rs` — tail `#[cfg(test)]` module (new file; tests written before the impl):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id_suffix: &str) -> RollbackEntry {
        RollbackEntry {
            removed_turns: vec![serde_json::json!({ "id": format!("t{id_suffix}"), "turnId": format!("t{id_suffix}"), "summary": "s", "items": [] })],
            prompt_text: format!("prompt{id_suffix}"),
            at_ms: 100,
        }
    }

    #[test]
    fn can_redo_is_a_stored_bit_and_destroy_aware() {
        let mut record = RollbackRecord::empty(50);
        assert!(!record.can_redo(), "a fresh record has nothing to redo");
        record.set_can_redo(true, 60);
        assert!(record.can_redo(), "the provider-stamped bit is the only source (claude keeps entries empty by design)");
        record.destroy_redo(70);
        assert!(!record.can_redo(), "destroyed redo never revives");
        assert!(!record.can_redo, "destroy also clears the stored bit");
        assert_eq!(record.last_op_at_ms, 70, "every op lifts the revision floor");
    }

    #[test]
    fn record_round_trips_through_json() {
        let mut record = RollbackRecord::empty(50);
        record.original_session_id = Some("orig-uuid".into());
        record.original_tip_uuid = Some("tip-uuid".into());
        record.push_entry(entry("1"), 60);
        record.set_can_redo(true, 61);
        let v = serde_json::to_value(&record).expect("serialize");
        let back: RollbackRecord = serde_json::from_value(v).expect("deserialize");
        assert_eq!(record, back);
    }
}
```

`crates/freshell-freshagent/src/identity_sink.rs` — append to its `#[cfg(test)] mod tests`:

```rust
    #[tokio::test]
    async fn fake_sink_records_and_loads_rollback() {
        let fake = std::sync::Arc::new(FakeIdentitySink::default());
        let mut record = crate::rollback_record::RollbackRecord::empty(10);
        record.push_entry(crate::rollback_record::RollbackEntry {
            removed_turns: vec![serde_json::json!({"id": "t1"})],
            prompt_text: "p1".into(),
            at_ms: 11,
        }, 12);
        fake.record_rollback("opencode", "ses_1", record.clone()).await.expect("write ok");
        assert_eq!(fake.load_rollback("opencode", "ses_1"), Some(record));
        assert!(fake.load_rollback("opencode", "nope").is_none());
    }
```

`crates/freshell-server/src/identity_sink.rs` — append to its `#[cfg(test)] mod tests`:

```rust
    #[tokio::test(flavor = "multi_thread")]
    async fn rollback_record_writes_through_and_reads_back() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(tmp.path().to_path_buf())));
        let sink = LedgerIdentitySink::new(ledger);
        let mut record = freshell_freshagent::RollbackRecord::empty(100);
        record.push_entry(freshell_freshagent::RollbackEntry {
            removed_turns: vec![serde_json::json!({"id": "t1", "turnId": "t1"})],
            prompt_text: "second prompt".into(),
            at_ms: 101,
        }, 102);
        sink.record_rollback("codex", "thr-1", record.clone()).await.expect("awaited write");
        assert_eq!(sink.load_rollback("codex", "thr-1"), Some(record), "awaited write => readable immediately");
        // A fresh ledger over the same root sees the row (durable, not just memory):
        let ledger2 = freshell_ws::pane_ledger::PaneLedger::new(Some(tmp.path().to_path_buf()));
        assert!(ledger2.load_rollback_row("codex", "thr-1").is_some(), "boot scan indexes rollback rows");
    }
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-contract.test.ts test/unit/shared/fresh-agent-slash-commands.test.ts && npm run test:vitest -- run test/server/ws-protocol.test.ts --config config/vitest/vitest.server.config.ts && cargo test -p freshell-freshagent rollback_record && cargo test -p freshell-freshagent identity_sink && cargo test -p freshell-server identity_sink && cargo test -p freshell-ws --test freshagent_rollback_refusal`

Expected: FAIL because `FreshAgentUndoSchema`/`FreshAgentRedoSchema` don't exist in the unions (zod rejects the frames), the slash catalog has no undo/redo entries and the action union lacks the variants (typecheck fails), the contract schemas lack the new keys (strict parse rejects), `rollback_record.rs` doesn't exist (compile error), the trait methods don't exist, `record_rollback_row`/`load_rollback_row` don't exist, and the WS dispatch has no undo/redo arms (unparseable typed frame ⇒ no refusal on the sink ⇒ `next_frame_of_type` times out).

- [ ] **Step 3: Add the minimal production implementation**

`shared/ws-protocol.ts` — after `FreshAgentForkSchema` (line 602):

```ts
const freshAgentRollbackShape = {
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  cwd: z.string().optional(),
  mode: z.enum(['step', 'toTurn']).optional(),
  turnId: z.string().min(1).optional(),
} as const

/** kata 1wxv: conversation rollback. mode absent => 'step'. turnId required by the SERVER for 'toTurn'. */
export const FreshAgentUndoSchema = z.object({
  type: z.literal('freshAgent.undo'),
  ...freshAgentRollbackShape,
})

export const FreshAgentRedoSchema = z.object({
  type: z.literal('freshAgent.redo'),
  ...freshAgentRollbackShape,
})
```

Register both in `FreshAgentClientMessageSchema` (:604) and `ClientMessageSchema` (:723-731, after `FreshAgentForkSchema`).

`shared/ws-version.ts`: `export const WS_PROTOCOL_VERSION = 8 as const`

`shared/fresh-agent-contract.ts`:

```ts
// FreshAgentCapabilitiesSchema — append two optionals inside the .strict() object:
  undo: z.boolean().optional(),
  redo: z.boolean().optional(),

// FreshAgentTurnSchema — append inside the .strict() object:
  rolledBack: z.boolean().optional(),

// FreshAgentSnapshotSchema — append inside the .extend({...}) block:
  rolledBackTurns: z.array(FreshAgentTurnSchema).optional(),
  rollback: z.object({
    canRedo: z.boolean(),
    undoneDepth: z.number().int().nonnegative(),
  }).strict().optional(),
```

`shared/fresh-agent-slash-commands.ts`:

```ts
export type FreshAgentSlashCommandAction = 'new' | 'compact' | 'fork' | 'model' | 'undo' | 'redo'

// in BASE_COMMANDS, after the fork entry:
  {
    name: 'undo',
    description: 'Roll back the last turn (conversation only — files stay as they are)',
    action: 'undo',
  },
// /redo is CAPABILITY-FILTERED out of the freshcodex catalog (decision 5 — no "show then
// reject"): the catalog builder (`getFreshAgentSlashCommands`) omits the redo entry when
// sessionType === 'freshcodex' and registers it for freshclaude/kilroy/freshopencode only.
// The server-side codex×redo refusal stays as the permanent wire backstop (refusal matrix).
  {
    name: 'redo',
    description: 'Restore the last rolled-back turn',
    action: 'redo',
  },

// r3 correction 8: the reserved-name set the COMPOSER intercepts before catalog resolution
// (Task 6's seam); exported so composer + view + tests share one source.
export const RESERVED_ROLLBACK_SLASH_NAMES = ['undo', 'redo'] as const
```

`crates/freshell-protocol/src/client_messages.rs`:

```rust
// after the FreshAgentFork arm:
    #[serde(rename = "freshAgent.undo")]
    FreshAgentUndo(FreshAgentUndo),
    #[serde(rename = "freshAgent.redo")]
    FreshAgentRedo(FreshAgentRedo),

// CLIENT_MESSAGE_TYPES 31 -> 33; insert "freshAgent.redo" after "freshAgent.question.respond"
// and "freshAgent.undo" after "freshAgent.send" (alphabetical); update the array size + header comment.

// structs after FreshAgentFork:
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RollbackMode {
    Step,
    ToTurn,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentUndo {
    pub provider: AgentProvider,
    pub session_id: String,
    pub session_type: SessionType,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<RollbackMode>, // absent => step
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentRedo {
    pub provider: AgentProvider,
    pub session_id: String,
    pub session_type: SessionType,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<RollbackMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}
```

`crates/freshell-protocol/src/lib.rs:37` → `pub const WS_PROTOCOL_VERSION: u32 = 8;` (+ doc); `src/common.rs:5` doc fix; `tests/version.rs:26` assert 8 (+ comment at :67); `tests/inventory.rs` 33/58/91 + rename the combined test; `tests/pane_reconcile.rs` literals → the const (refresh comment); `crates/freshell-server/tests/safe11_term22_shutdown_reaping.rs:312` and `crates/freshell-ws/src/lib.rs:947,954` → 8 / the const where importable.

Create `crates/freshell-freshagent/src/rollback_record.rs` exactly per the Interfaces block (record types + request normalization + pinned consts + the three frame builders). Frame builders stamp `provider`/`session_type` from the op via the same wire helpers the fork path uses (`agent_provider_wire`-equivalents live in the protocol crate; if private, stamp from the op's enum with a local `match` mirroring `session_type_str`): inner payloads per Wire Design:

```rust
// rollback_error_frame: {"type":"freshAgent.error","sessionId","code","message","requestId","rollback":true}
// rollback_ack_frame (direction Undo): {"type":"freshAgent.rolledBack","requestId","sessionId":live,
//   "direction":"undo","mode":"step"|"toTurn","removedPromptText": prompt or omitted,
//   "removedTurnIds":[..],"canRedo":bool, "newSessionId" only when Some}
// (direction Redo): {"type":"freshAgent.redone","requestId","sessionId":live,"direction":"redo",
//   "restoredThroughTurnId": removed_turn_ids.last() or omitted,"canRedo":bool,...}
// rollback_broadcast_frame (Undo): {"type":"freshAgent.session.rolledBack","sessionId":live,
//   "removedTurnIds":[..],"canRedo":bool,"revokeAttention":true}
// (Redo): {"type":"freshAgent.session.redone","sessionId":live,
//   "restoredThroughTurnId": removed_turn_ids.last() or omitted,"canRedo":bool}
```

`crates/freshell-freshagent/src/identity_sink.rs`: extend the trait + `FakeIdentitySink` (a `pub rollbacks: Mutex<HashMap<(String,String), RollbackRecord>>`; `record_rollback` inserts unless `fail_writes`, then returns `write_result()`; `load_rollback` clones). `crates/freshell-freshagent/src/lib.rs`: `pub mod rollback_record;` + re-export the record types at crate root (match how `PaneIdentitySink`/`FreshAgentSettings` are re-exported — `freshell-server` imports them from the crate root today).

`crates/freshell-ws/src/pane_ledger.rs` — third row kind:

```rust
/// Rollback rows (kata 1wxv) — fresh-agent conversation-rollback state keyed
/// (provider, sessionId): `rollback/<enc(provider)>/<enc(sessionId)>.json`.
/// Payload-OPAQUE to the ledger: freshell_freshagent::rollback_record owns the schema.
fn rollback_path(root: &Path, provider: &str, session_id: &str) -> PathBuf {
    root.join("rollback").join(enc(provider)).join(format!("{}.json", enc(session_id)))
}

pub fn record_rollback_row(&self, provider: &str, session_id: &str, payload: &serde_json::Value, _now_ms: i64) -> std::io::Result<()> {
    let dest = Self::rollback_path(&self.root_path_for_writes()/* whatever the bindings writer uses */, provider, session_id);
    std::fs::create_dir_all(dest.parent().expect("rollback parent"))?;
    write_row_atomic(&dest, payload)?;
    self.rollback_index.write().expect("rollback index").insert((provider.to_string(), session_id.to_string()), payload.clone());
    Ok(())
}

pub fn load_rollback_row(&self, provider: &str, session_id: &str) -> Option<serde_json::Value> {
    self.rollback_index.read().expect("rollback index").get(&(provider.to_string(), session_id.to_string())).cloned()
}
```

(Use the identical root/enc helpers the binding-row writer uses — mirror, don't invent. `enc` is the existing percent-encoding helper; the struct gains `rollback_index: RwLock<HashMap<(String, String), serde_json::Value>>` initialized in `new`/`new_locked` and populated by the `pane_ledger_scan.rs` boot walk, which gains a `rollback/` subtree arm mirroring the bindings walk with per-row quarantine.)

`crates/freshell-server/src/identity_sink.rs` — implement the two new trait methods per Interfaces (`serde_json::to_value(&record).map_err(std::io::Error::other)?` inside the `spawn_blocking`; `load_rollback` filters `record.version == ROLLBACK_RECORD_VERSION` else `None`).

`crates/freshell-ws/src/terminal.rs` — refusal helper + arms (Task 1 answers every provider):

```rust
/// kata 1wxv Task 1 refusal: every provider x op cell is answered ON THE
/// REQUESTING CONNECTION until the provider legs (Tasks 2-4) replace the cells
/// with real dispatch; codex x redo and amplifier x op stay refused forever.
/// Stamped `rollback:true` + `requestId` so the client shows the notice channel,
/// not the pane error surface.
fn rollback_refusal_frame(op: &RollbackRequest, wording: &str) -> ServerMessage {
    freshell_freshagent::rollback_error_frame(
        op, "UNSUPPORTED_CAPABILITY",
        &format!("{wording} not supported for {}", session_type_wire(op.session_type)),
    )
}

// in the big dispatch match, beside the FreshAgentFork arm:
ClientMessage::FreshAgentUndo(m) => {
    conn_sink(rollback_refusal_frame(&RollbackRequest::from_undo(m), "Undo is"));
    true
}
ClientMessage::FreshAgentRedo(m) => {
    conn_sink(rollback_refusal_frame(&RollbackRequest::from_redo(m), "Redo is"));
    true
}
```

Then `npm run contract:generate` and commit the regenerated `port/contract/*.json` with this task.

Version-literal sweep (all listed in Files): `protocolVersion: 7` → `protocolVersion: 8` in the nine e2e files; `test/unit/port/normalize.test.ts` imports `WS_PROTOCOL_VERSION` and uses it at both sites.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:port && npm run test:vitest -- run test/unit/shared/fresh-agent-contract.test.ts test/unit/shared/fresh-agent-slash-commands.test.ts test/unit/port/normalize.test.ts && npm run test:vitest -- run test/server/ws-protocol.test.ts --config config/vitest/vitest.server.config.ts && cargo test -p freshell-protocol && cargo test -p freshell-freshagent rollback_record && cargo test -p freshell-freshagent identity_sink && cargo test -p freshell-server identity_sink && cargo test -p freshell-ws --test freshagent_rollback_refusal`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Review duplicated wire-stamping logic between `rollback_record.rs` frame builders and the existing event builders; keep the builders dumb/serde-only with no provider branching beyond direction. Confirm zod `freshAgentRollbackShape` spread produces NO schema identity drift (the freeze tests gate it). No behavior change.

- [ ] **Step 6: Run impacted-test verification**

The version bump touches every WS handshake (all clients/servers/e2e): the impacted set is the full Rust workspace test surface plus the port contract plus every suite that opens a socket.

Run: `npm run test:port && cargo test -p freshell-protocol -p freshell-ws -p freshell-server -p freshell-freshagent -p freshell-codex -p freshell-opencode && cargo fmt --all --check && npm run test:vitest -- run test/unit/shared && npm run test:vitest -- run test/server/ws-protocol.test.ts test/server/ws-claude-activity.test.ts test/server/ws-handshake-snapshot.test.ts --config config/vitest/vitest.server.config.ts && npm run test:e2e -- --project=rust-chromium fresh-agent-control-rust -g "compact"`

Expected: PASS (the single rust-chromium compact test proves the v8 handshake end-to-end against a real Rust server)

- [ ] **Step 7: Commit the task**

```bash
git add shared/ws-protocol.ts shared/ws-version.ts shared/fresh-agent-contract.ts shared/fresh-agent-slash-commands.ts port/contract/ws-protocol.schema.json port/contract/ws-message-inventory.json port/contract/ws-server-messages.schema.json crates/freshell-protocol crates/freshell-ws crates/freshell-server crates/freshell-freshagent test/server/ws-protocol.test.ts test/unit/shared/fresh-agent-contract.test.ts test/unit/shared/fresh-agent-slash-commands.test.ts test/unit/port/normalize.test.ts test/e2e-browser/helpers/ws-capture.ts test/e2e-browser/specs
git commit -m "feat(fresh-agent): undo/redo wire contract v8, durable rollback record plumbing, refusal surface (kata 1wxv task 1)"
git diff --exit-code HEAD -- port/contract && echo CONTRACT_REGEN_CLEAN
```

(Post-commit cleanliness check: `CONTRACT_REGEN_CLEAN` prints, proving the regenerated contract artifacts were committed by this task's commit, not merely regenerated locally.)

---

### Task 2: Codex undo leg (`thread/revert`; undo-only)

**Stage-2 binding amendments (from "## Load-bearing corrections", item 1):**
- ALL freshcodex `thread/start` calls SET `historyMode:"paginated"` and record it on the freshell-side session record: `CodexSession` gains `history_mode: Option<HistoryMode>` — `Some(Paginated)` for threads freshell started (we SET the mode at start). RESUME/ADOPTION IS DURABLY READABLE (r3 — replaces "resumed/adopted threads record `None` (unknown ⇒ legacy)" as the permanent verdict): `thread/resume` takes no mode param, but the rollout persists the mode — `CodexSession::resume`/adoption parses the rollout file's persisted `session_meta.history_mode` (validator-C proved the mode persists there; freshell-codex already reads rollouts for durability) and records `Some(Paginated)` when the meta says paginated; ONLY a missing/unparseable mode stamps legacy (`None` ⇒ `undo:false`). The app-server exposes no live mode read-back — the durable rollout meta is the source of truth (the in-memory record caches it), and the runtime `-32600` mapping below stays as belt (a thread paginated externally whose meta is unreadable by us ⇒ `undo:false` — capability never over-advertised; the known-legacy copy still fires on the refusal path). Files list gains the start-path modification (same `app_server.rs` client + the `codex.rs` create/resume paths that build StartParams) plus the resume-path rollout-meta parse in `crates/freshell-codex` (the existing rollout-reader module).
- Legacy threads (created before this feature): do NOT detect pre-emptively — call `thread/revert`, and map the observed `-32600 "thread/revert only supports paginated threads"` error to `UNSUPPORTED_CAPABILITY` + `CODEX_LEGACY_THREAD_COPY` (pinned in the corrections section). Non-destructive: the refusal only fires when revert FAILED.
- The mid-turn `BUSY_TURN` refusal test must additionally prove the provider was never reached: assert NO `thread/revert` (and no `turn/interrupt`) frame appears on the fake transport during the refused attempt (validator extra-1: provider revert force-interrupts then proceeds — a gate hole is silent corruption).
- Codex empty-prefix toTurn (undo-to-here on the first turn) is LEGAL: `thread/revert` before the first turn succeeds and empties the thread (validator-C). No `INVALID_ROLLBACK_TARGET` first-turn case exists for codex; only `NOTHING_TO_UNDO` on empty history.
- Zero-turn paginated threads answer `-32601 list_turns is not supported yet` to read/includeTurns and turns/list until the first turn commits (existing read fallback covers; add one regression assertion).

**Files:**
- Modify: `crates/freshell-codex/src/app_server.rs` (new `revert_thread`, beside `archive_thread` at :391-404; `thread/start` StartParams gain `historyMode:"paginated"`)
- Modify: `crates/freshell-freshagent/src/codex.rs` (`FreshCodexState` gains `rollback_in_flight: crate::InFlightRegistry`; `CodexSession` gains `history_mode: Option<HistoryMode>` + the per-session async `turn_lock: Arc<tokio::sync::Mutex<()>>`; `handle_rollback`; `resolve_codex_boundary` + `codex_turn_plain_text` helpers; `handle_send` sets the busy truth UNDER `turn_lock` BEFORE `turn/start` is written, and destroys redo)
- Modify: `crates/freshell-ws/src/terminal.rs` (codex undo arm routes to `handle_rollback`; codex redo stays refused — the permanent decision-5 cell)
- Modify: `crates/freshell-ws/tests/freshagent_rollback_refusal.rs` (the codex×undo case is removed from the refusal matrix — it is now real dispatch; the codex×redo case stays and is explicitly commented permanent per decision 5)
- Test: `crates/freshell-freshagent/src/codex.rs` (in-file `#[cfg(test)]` module, fork-harness idioms), `crates/freshell-codex/tests/app_server_drive.rs` (append wire-shape test)

**Interfaces:**
- Consumes: `crate::rollback_record::{RollbackRequest, RollbackDirection, RollbackModeReq, RollbackRecord, RollbackEntry, rollback_error_frame, rollback_ack_frame, rollback_broadcast_frame, ROLLBACK_BUSY_MESSAGE}`; `PaneIdentitySink::record_rollback/load_rollback`; `ensure_session_alive` + `EnsureAliveOutcome`/`EnsureAliveError` arms (codex.rs:1416-1443); `strip_codex_row_suffix` (codex.rs:4042); the existing fork-test harness (`state_with_bus`, `insert_fake_session`, `capturing_sink`, `captured_frames`, `freshell_codex::new_channel_transport`, `peer.expect_request()/respond()/respond_error()`, `answer_initialize`).
- Produces:
  - `CodexAppServerClient::revert_thread(&self, thread_id: &str, before_turn_id: &str) -> Result<(), CodexAppServerError>` (wire: `thread/revert {threadId, beforeTurnId}`).
  - `FreshCodexState::handle_rollback(&self, op: RollbackRequest, reply_sink: FrameSink)`.
  - `resolve_codex_boundary(raw_turns: &[Value], mode: RollbackModeReq, turn_id: Option<&str>) -> Result<(String /* beforeTurnId */, Vec<Value> /* removed display turns */), CodexRollbackError>` with `CodexRollbackError::{NothingToUndo, TargetNotFound}`.
  - `codex_turn_plain_text(turn: &Value) -> String` (concat `text`-kind item texts of a display turn; fallback `summary`).
  - Refill prompt for the ack = `codex_turn_plain_text` of the FIRST removed display turn with `role == "user"`.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-freshagent/src/codex.rs` — in the fork tests' harness module:

```rust
// ── freshAgent.undo / freshAgent.redo (kata 1wxv Task 2) ────────────────

fn undo_msg(session_id: &str, request_id: &str, turn_id: Option<&str>) -> crate::rollback_record::RollbackRequest {
    crate::rollback_record::RollbackRequest {
        direction: crate::rollback_record::RollbackDirection::Undo,
        mode: if turn_id.is_some() { crate::rollback_record::RollbackModeReq::ToTurn } else { crate::rollback_record::RollbackModeReq::Step },
        turn_id: turn_id.map(str::to_string),
        session_id: session_id.to_string(),
        session_type: freshell_protocol::SessionType::Freshcodex,
        provider: freshell_protocol::AgentProvider::Codex,
        request_id: request_id.to_string(),
        cwd: None,
    }
}

/// Two raw completed turns; the item JSON mirrors the existing
/// `build_codex_turn_json`/`get_snapshot` fixtures in this file — reuse the
/// exact raw-turn shape pinned there (do NOT invent item type names).
fn two_turn_thread_read(thread_id: &str) -> Value {
    json!({ "thread": { "id": thread_id, "turns": [
        { "id": "turn-1", "status": "completed", "items": [
            { "type": "userMessage", "id": "t1-u", "content": [{ "type": "text", "text": "first prompt" }] },
            { "type": "agentMessage", "id": "t1-a", "text": "first answer" },
        ]},
        { "id": "turn-2", "status": "completed", "items": [
            { "type": "userMessage", "id": "t2-u", "content": [{ "type": "text", "text": "second prompt" }] },
            { "type": "agentMessage", "id": "t2-a", "text": "second answer" },
        ]},
    ]}})
}

#[tokio::test]
async fn handle_rollback_step_reverts_the_last_turn_and_answers_with_the_removed_prompt() {
    let (st, mut rx) = state_with_sink(); // the fake-identity-sink state builder the fork binding tests use; if only state_with_bus() exists locally, extend it to return (state, rx, Arc<FakeIdentitySink>) per the file's harness conventions
    let (transport, peer) = freshell_codex::new_channel_transport();
    let (client, _notifs) = CodexAppServerClient::connect(transport);
    insert_fake_session(&st.0, "thr-undo-1", Arc::new(client), Arc::new(StdMutex::new(None)), spawn_sleeper(), "codex-sidecar-test-undo-1").await;

    let (sink, captured) = capturing_sink();
    let driver = {
        let st = st.0.clone();
        tokio::spawn(async move { st.handle_rollback(undo_msg("thr-undo-1", "rb-1", None), sink).await; })
    };
    answer_initialize(&peer).await;

    // Pre-revert capture happens BEFORE the destructive RPC.
    let (read_id, method, read_params) = peer.expect_request().await;
    assert_eq!(method, "thread/read");
    assert_eq!(read_params["threadId"], json!("thr-undo-1"));
    assert_eq!(read_params["includeTurns"], json!(true));
    peer.respond(&read_id, two_turn_thread_read("thr-undo-1"));

    let (revert_id, method2, revert_params) = peer.expect_request().await;
    assert_eq!(method2, "thread/revert");
    assert_eq!(revert_params, json!({ "threadId": "thr-undo-1", "beforeTurnId": "turn-2" }));
    peer.respond(&revert_id, json!({}));
    driver.await.expect("rollback task");

    let frames = captured_frames(&captured);
    assert_eq!(frames.len(), 1, "one ack on the requesting sink: {frames:?}");
    let frame = &frames[0];
    assert_eq!(frame["type"], "freshAgent.event");
    assert_eq!(frame["event"]["type"], "freshAgent.rolledBack");
    assert_eq!(frame["event"]["requestId"], json!("rb-1"));
    assert_eq!(frame["event"]["direction"], json!("undo"));
    assert_eq!(frame["event"]["removedPromptText"], json!("second prompt"));
    let removed = frame["event"]["removedTurnIds"].as_array().expect("ids array");
    assert_eq!(removed.len(), 2, "the raw turn splits into user+assistant display rows");
    assert!(removed.iter().all(|id| id.as_str().unwrap_or_default().starts_with("turn-2")), "split-row ids carry the raw prefix: {removed:?}");
    assert_eq!(frame["event"]["canRedo"], json!(false), "codex is undo-only (decision 5)");

    // Broadcast converges siblings + revokes attention; NEVER a turn.complete (no chime).
    let mut saw_rolledback = false;
    while let Ok(raw) = rx.try_recv() {
        let v: Value = serde_json::from_str(&raw).expect("broadcast frame json");
        assert_ne!(v["event"]["type"], json!("freshAgent.turn.complete"), "rollback never chimes");
        if v["event"]["type"] == json!("freshAgent.session.rolledBack") {
            saw_rolledback = true;
            assert_eq!(v["event"]["sessionId"], json!("thr-undo-1"));
            assert_eq!(v["event"]["revokeAttention"], json!(true));
            assert_eq!(v["event"]["canRedo"], json!(false));
            assert!(v["event"]["removedPromptText"].is_null(), "broadcast never carries the prompt (other devices' composers are untouched)");
        }
    }
    assert!(saw_rolledback, "the broadcast bus carried session.rolledBack");

    // Durable record (codex: append-only entries; stored can_redo always false).
    let record = st.2.load_rollback("codex", "thr-undo-1").expect("rollback record written");
    assert_eq!(record.entries.len(), 1);
    assert_eq!(record.entries[0].prompt_text, "second prompt");
    assert!(!record.can_redo());
}

#[tokio::test]
async fn handle_rollback_record_write_failure_refuses_and_never_reverts() {
    // Durable-BEFORE-mutation: a failed record pre-write refuses the rollback with
    // INTERNAL_ERROR + LEDGER_WRITE_REFUSAL_COPY and the provider history is NEVER mutated.
    let (st, _rx) = state_with_sink();
    let (transport, peer) = freshell_codex::new_channel_transport();
    let (client, _notifs) = CodexAppServerClient::connect(transport);
    insert_fake_session(&st.0, "thr-undo-nowrite", Arc::new(client), Arc::new(StdMutex::new(None)), spawn_sleeper(), "codex-sidecar-test-undo-nowrite").await;
    st.2.set_fail_writes(true); // FakeIdentitySink write-failure flag (Task 1 fake surface)
    let (sink, captured) = capturing_sink();
    let driver = {
        let st = st.0.clone();
        tokio::spawn(async move { st.handle_rollback(undo_msg("thr-undo-nowrite", "rb-6", None), sink).await; })
    };
    answer_initialize(&peer).await;
    let (read_id, method, _params) = peer.expect_request().await;
    assert_eq!(method, "thread/read", "pre-mutation reads are still allowed");
    peer.respond(&read_id, two_turn_thread_read("thr-undo-nowrite"));
    driver.await.expect("rollback task");
    let frames = captured_frames(&captured);
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0]["event"]["code"], json!("INTERNAL_ERROR"));
    assert_eq!(frames[0]["event"]["message"], json!(crate::rollback_record::LEDGER_WRITE_REFUSAL_COPY));
    assert_eq!(frames[0]["event"]["rollback"], json!(true));
    assert!(tokio::time::timeout(std::time::Duration::from_millis(100), peer.next_frame()).await.is_err(),
        "no thread/revert is issued once the record cannot be saved");
}

#[tokio::test]
async fn handle_rollback_to_turn_strips_the_row_suffix_and_removes_the_tail() {
    // Same rig; `turn-1:row-0` (display id) must revert at raw id `turn-1`, removing BOTH turns.
    let (st, _rx) = state_with_sink();
    let (transport, peer) = freshell_codex::new_channel_transport();
    let (client, _notifs) = CodexAppServerClient::connect(transport);
    insert_fake_session(&st.0, "thr-undo-2", Arc::new(client), Arc::new(StdMutex::new(None)), spawn_sleeper(), "codex-sidecar-test-undo-2").await;
    let (sink, captured) = capturing_sink();
    let driver = {
        let st = st.0.clone();
        tokio::spawn(async move { st.handle_rollback(undo_msg("thr-undo-2", "rb-2", Some("turn-1:row-0")), sink).await; })
    };
    answer_initialize(&peer).await;
    let (read_id, _m, _p) = peer.expect_request().await;
    peer.respond(&read_id, two_turn_thread_read("thr-undo-2"));
    let (revert_id, method, params) = peer.expect_request().await;
    assert_eq!(method, "thread/revert");
    assert_eq!(params["beforeTurnId"], json!("turn-1"), "the :row-N suffix is stripped");
    peer.respond(&revert_id, json!({}));
    driver.await.expect("rollback task");
    let frames = captured_frames(&captured);
    let removed = frames[0]["event"]["removedTurnIds"].as_array().expect("ids").len();
    assert_eq!(removed, 4, "both raw turns -> four display rows");
    assert_eq!(frames[0]["event"]["removedPromptText"], json!("first prompt"));
}

#[tokio::test]
async fn handle_rollback_mid_turn_is_busy_without_touching_the_sidecar() {
    let (st, _rx) = state_with_sink();
    let (transport, peer) = freshell_codex::new_channel_transport();
    let (client, _notifs) = CodexAppServerClient::connect(transport);
    insert_fake_session(&st.0, "thr-undo-busy", Arc::new(client), Arc::new(StdMutex::new(Some("turn-live".to_string()))), spawn_sleeper(), "codex-sidecar-test-undo-busy").await;
    let (sink, captured) = capturing_sink();
    st.0.handle_rollback(undo_msg("thr-undo-busy", "rb-3", None), sink).await;
    let frames = captured_frames(&captured);
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0]["event"]["code"], json!("BUSY_TURN"));
    assert_eq!(frames[0]["event"]["message"], json!(crate::rollback_record::ROLLBACK_BUSY_MESSAGE));
    assert_eq!(frames[0]["event"]["rollback"], json!(true));
    assert_eq!(frames[0]["event"]["requestId"], json!("rb-3"));
    assert!(tokio::time::timeout(std::time::Duration::from_millis(100), peer.next_frame()).await.is_err(),
        "a mid-turn rollback issues ZERO RPCs");
}

#[tokio::test]
async fn handle_rollback_redo_is_refused_codex_is_undo_only() {
    let (st, _rx) = state_with_sink();
    let (sink, captured) = capturing_sink();
    let mut op = undo_msg("thr-anything", "rb-4", None);
    op.direction = crate::rollback_record::RollbackDirection::Redo;
    st.0.handle_rollback(op, sink).await;
    let frames = captured_frames(&captured);
    assert_eq!(frames[0]["event"]["code"], json!("UNSUPPORTED_CAPABILITY"));
    assert_eq!(frames[0]["event"]["message"], json!("Redo is not supported for freshcodex (codex history revert is destructive; there is no redo primitive)."));
}

#[tokio::test]
async fn handle_rollback_empty_history_says_nothing_to_undo_and_never_reverts() {
    let (st, _rx) = state_with_sink();
    let (transport, peer) = freshell_codex::new_channel_transport();
    let (client, _notifs) = CodexAppServerClient::connect(transport);
    insert_fake_session(&st.0, "thr-undo-empty", Arc::new(client), Arc::new(StdMutex::new(None)), spawn_sleeper(), "codex-sidecar-test-undo-empty").await;
    let (sink, captured) = capturing_sink();
    let driver = {
        let st = st.0.clone();
        tokio::spawn(async move { st.handle_rollback(undo_msg("thr-undo-empty", "rb-5", None), sink).await; })
    };
    answer_initialize(&peer).await;
    let (read_id, _m, _p) = peer.expect_request().await;
    peer.respond(&read_id, json!({ "thread": { "id": "thr-undo-empty", "turns": [] } }));
    driver.await.expect("rollback task");
    let frames = captured_frames(&captured);
    assert_eq!(frames[0]["event"]["code"], json!("NOTHING_TO_UNDO"));
    assert_eq!(frames[0]["event"]["message"], json!(crate::rollback_record::UNDO_EMPTY_MESSAGE));
    assert!(tokio::time::timeout(std::time::Duration::from_millis(100), peer.next_frame()).await.is_err(),
        "no thread/revert on empty history");
}

#[tokio::test]
async fn handle_send_permanently_destroys_redo() {
    let (st, _rx) = state_with_sink();
    st.2.record_rollback("codex", "thr-send-destroy", {
        let mut r = crate::rollback_record::RollbackRecord::empty(1);
        r.push_entry(crate::rollback_record::RollbackEntry { removed_turns: vec![json!({"id":"t9"})], prompt_text: "p".into(), at_ms: 2 }, 3);
        r
    }).await.expect("seed");
    // Register + drive a real send (mirror the existing handle_send tests' rig exactly:
    // scripted initialize + turn/start answers), then:
    let record = st.2.load_rollback("codex", "thr-send-destroy").expect("record survives");
    assert!(record.redo_destroyed, "any new submission permanently destroys redo (decision 5)");
    assert_eq!(record.entries.len(), 1, "markers survive the destroy (decision 6)");
}

#[tokio::test]
async fn handle_rollback_after_a_destroyed_redo_starts_a_new_epoch_but_keeps_all_markers() {
    // r3 epoch rule (supersedes r2's "old entries dropped"): seed a record
    // { entries: [<old-epoch marker>], redo_destroyed: true } (the undo→send path above),
    // then drive one more undo against the two-turn read; the record must carry the UNION
    // of both epochs' entries in conversation order (markers persist marked in the ledger —
    // thread/revert DESTROYED the old tail, so only the ledger keeps them, decision 6),
    // redo_destroyed cleared (the record's redo state now describes the NEW chain; the prior
    // chain's redo stays permanently dead), can_redo false (codex is undo-only).
    let (st, _rx) = state_with_sink();
    let (transport, peer) = freshell_codex::new_channel_transport();
    let (client, _notifs) = CodexAppServerClient::connect(transport);
    insert_fake_session(&st.0, "thr-epoch", Arc::new(client), Arc::new(StdMutex::new(None)), spawn_sleeper(), "codex-sidecar-test-epoch").await;
    st.2.record_rollback("codex", "thr-epoch", {
        let mut r = crate::rollback_record::RollbackRecord::empty(1);
        r.push_entry(crate::rollback_record::RollbackEntry { removed_turns: vec![json!({"id":"old-epoch"})], prompt_text: "old".into(), at_ms: 2 }, 3);
        r.destroy_redo(4);
        r
    }).await.expect("seed");
    let (sink, _captured) = capturing_sink();
    let driver = {
        let st = st.0.clone();
        tokio::spawn(async move { st.handle_rollback(undo_msg("thr-epoch", "rb-epoch", None), sink).await; })
    };
    answer_initialize(&peer).await;
    let (read_id, _m, _p) = peer.expect_request().await;
    peer.respond(&read_id, two_turn_thread_read("thr-epoch"));
    let (revert_id, _m2, _p2) = peer.expect_request().await;
    peer.respond(&revert_id, json!({}));
    driver.await.expect("rollback task");
    let record = st.2.load_rollback("codex", "thr-epoch").expect("record");
    assert!(!record.redo_destroyed, "the redo state now describes the new chain (the prior chain's redo stays dead)");
    assert_eq!(record.entries.len(), 2, "r3: the UNION of every epoch's markers — entries are never dropped");
    assert_eq!(record.entries[0].prompt_text, "old");
    assert_eq!(record.entries[1].prompt_text, "second prompt");
}

#[tokio::test]
async fn concurrent_send_plus_undo_serializes_on_the_turn_lock_without_deadlock() {
    // r2 lock discipline: script a SLOW thread/revert response; start handle_rollback, then
    // fire handle_send mid-flight; wrap the whole join in a bounded tokio::time::timeout
    // (no deadlock); assert the request order shows thread/revert strictly BEFORE turn/start
    // (the send waited on the session turn lock held across the rollback), and assert the
    // final record is the post-rollback record with redo_destroyed applied (send waits,
    // rollback wins, then destroys). handle_send never touches
    // rollback_in_flight — its ONLY wait point is the turn lock.
}

#[tokio::test]
async fn resume_parses_the_rollouts_durable_history_mode() {
    // r3 durability (fresh-eyes r3 F2): write a fake rollout whose session_meta carries
    // history_mode "paginated" (the validator-C-verified persistence site), drive the
    // thread/resume / adoption path, and assert the resulting CodexSession.history_mode ==
    // Some(Paginated) — undo capability SURVIVES normal session rehydration. Variants:
    // meta missing and meta unparseable => None (legacy stamps, undo:false). The existing
    // freshell-codex rollout-reader fixture idioms are reused, not reinvented.
}
```

`crates/freshell-codex/tests/app_server_drive.rs` — append:

```rust
#[tokio::test]
async fn thread_revert_uses_the_experimental_wire_shape() {
    // Mirror this file's existing scripted-peer helper names; the intent:
    let (transport, peer) = freshell_codex::new_channel_transport();
    let (client, _notifs) = CodexAppServerClient::connect(transport);
    let call = tokio::spawn(async move { client.revert_thread("thr-1", "turn-9").await });
    let (id, method, params) = peer.expect_request().await;
    assert_eq!(method, "thread/revert");
    assert_eq!(params, serde_json::json!({ "threadId": "thr-1", "beforeTurnId": "turn-9" }));
    peer.respond(&id, serde_json::json!({}));
    assert!(call.await.expect("join").is_ok());
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent codex::tests::handle_rollback && cargo test -p freshell-codex --test app_server_drive thread_revert`

Expected: FAIL because `revert_thread`, `FreshCodexState::handle_rollback`, `rollback_in_flight`, and the `destroy_redo_on_submit` hook in `handle_send` do not exist (compile errors), and the codex undo frame is still answered by the Task-1 refusal (the dispatch test in Task 3's neighbor file pins that until this leg lands).

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-codex/src/app_server.rs` (after `unarchive_thread`, :400-404):

```rust
/// `thread/revert` (codex 0.149.0, EXPERIMENTAL) — in-place, same-thread-id
/// conversation rollback: durable history is replaced by the prefix strictly
/// BEFORE `before_turn_id`. Conversation-only (the provider leaves files to
/// the client) and DESTRUCTIVE — there is no native redo. The removed tail
/// must be captured by the caller BEFORE this RPC.
pub async fn revert_thread(
    &self,
    thread_id: &str,
    before_turn_id: &str,
) -> Result<(), CodexAppServerError> {
    self.request("thread/revert", json!({ "threadId": thread_id, "beforeTurnId": before_turn_id }))
        .await?;
    Ok(())
}
```

`crates/freshell-freshagent/src/codex.rs` — struct + constructor: add `rollback_in_flight: crate::InFlightRegistry` beside `fork_in_flight` (codex.rs:163-174), initialized identically. `CodexSession` gains `history_mode: Option<HistoryMode>` (per the stage-2 amendment as r3-corrected: `Some(Paginated)` recorded at `thread/start` time; resumed/adopted threads take the mode parsed from the rollout's persisted `session_meta.history_mode` — `None` ONLY when that durable meta is missing/unparseable ⇒ legacy stamps) and `turn_lock: Arc<tokio::sync::Mutex<()>>` (the per-session async turn lock from the r2 serialization discipline). Then:

```rust
/// The codex rollback target math (kata decision 2/3): `raw_turns` from
/// `thread/read{includeTurns:true}`. Step = the LAST raw turn; toTurn = the
/// raw turn whose id equals `strip_codex_row_suffix(turn_id)`. Removed display
/// turns = the `build_codex_turn_json` projections of raw turns [boundary..].
fn resolve_codex_boundary(
    raw_turns: &[Value],
    mode: crate::rollback_record::RollbackModeReq,
    turn_id: Option<&str>,
) -> Result<(String, Vec<Value>), CodexRollbackError> {
    let boundary = match mode {
        crate::rollback_record::RollbackModeReq::Step => raw_turns.len(),
        crate::rollback_record::RollbackModeReq::ToTurn => {
            let target = strip_codex_row_suffix(turn_id.ok_or(CodexRollbackError::TargetNotFound)?);
            raw_turns
                .iter()
                .position(|t| t.get("id").and_then(Value::as_str) == Some(target))
                .ok_or(CodexRollbackError::TargetNotFound)?
        }
    };
    if boundary == 0 && raw_turns.is_empty() || boundary >= raw_turns.len() + 1 { unreachable!() }
    // boundary INDEX (Step => len-1; ToTurn => position); NothingToUndo when the index lands past the end.
    let idx = match mode {
        crate::rollback_record::RollbackModeReq::Step => raw_turns.len().checked_sub(1).ok_or(CodexRollbackError::NothingToUndo)?,
        crate::rollback_record::RollbackModeReq::ToTurn => boundary,
    };
    let before_turn_id = raw_turns[idx]
        .get("id").and_then(Value::as_str).filter(|id| !id.trim().is_empty())
        .ok_or(CodexRollbackError::TargetNotFound)?
        .to_string();
    let mut removed = Vec::new();
    for raw in &raw_turns[idx..] {
        removed.extend(build_codex_turn_json(raw, 0).map_err(|_| CodexRollbackError::TargetNotFound)?);
    }
    Ok((before_turn_id, removed))
}

/// Plain text of one display turn (the composer-refill payload): text-kind items joined, summary fallback.
fn codex_turn_plain_text(turn: &Value) -> String {
    let joined = turn["items"].as_array().map(|items| items.iter()
        .filter(|i| i["kind"] == "text")
        .filter_map(|i| i["text"].as_str())
        .collect::<Vec<&str>>().join("\n\n")).unwrap_or_default();
    if joined.is_empty() { turn["summary"].as_str().unwrap_or("").to_string() } else { joined }
}

pub async fn handle_rollback(&self, op: crate::rollback_record::RollbackRequest, reply_sink: freshell_terminal::FrameSink) {
    use crate::rollback_record::*;
    if op.direction == RollbackDirection::Redo {
        reply_sink(rollback_error_frame(&op, "UNSUPPORTED_CAPABILITY", "Redo is not supported for freshcodex (codex history revert is destructive; there is no redo primitive)."));
        return;
    }
    if op.mode == RollbackModeReq::ToTurn && op.turn_id.is_none() {
        reply_sink(rollback_error_frame(&op, "INVALID_ROLLBACK_TARGET", "undo toTurn requires a turnId"));
        return;
    }
    // ensure-alive parity with handle_fork (codex.rs:1416-1443) — same arms, keying the
    // rollback frame builders at the RESOLVED id on mint-new:
    let thread_id = match self.ensure_session_alive(&op.session_id).await {
        Ok(EnsureAliveOutcome::AlreadyRunning) | Ok(EnsureAliveOutcome::Recovered) => op.session_id.clone(),
        Ok(EnsureAliveOutcome::Respawned { new_session_id }) => new_session_id,
        Err(_) => { reply_sink(rollback_error_frame(&op, "INVALID_SESSION_ID", &format!("codex session {} not found", op.session_id))); return; }
    };
    // Serialization discipline (r2): ONE per-session async turn lock per lane. Lock ORDER
    // when both primitives co-occur: rollback_in_flight (rollback-vs-rollback only) FIRST,
    // then the session turn lock — which is held across the WHOLE handler (busy-check →
    // reads → revert → post-verify → record write → reply). handle_send NEVER acquires or
    // consults rollback_in_flight: it waits on the turn lock while a live rollback holds it,
    // then proceeds and destroys redo ("send waits, rollback wins, then destroys"). No lock
    // cycle exists — no circular wait, no deadlock.
    let Some(_guard) = self.rollback_in_flight.try_acquire(&thread_id) else {
        reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", &format!("rollback already in progress for {thread_id}")));
        return;
    };
    let (client, active_turn, turn_lock) = {
        let guard = self.sessions.lock().await;
        match guard.get(&thread_id) {
            Some(s) => (s.client.clone(), s.active_turn.clone(), s.turn_lock.clone()),
            None => { reply_sink(rollback_error_frame(&op, "INVALID_SESSION_ID", &format!("codex session {} not found", thread_id))); return; }
        }
    };
    let _turn = turn_lock.lock().await; // held for the REST of this handler
    // Busy truth is written by handle_send UNDER this same lock BEFORE turn/start goes out
    // (the check-then-set window is closed): observed idle here means no send is in flight.
    if active_turn.lock().expect("active_turn mutex").is_some() {
        reply_sink(rollback_error_frame(&op, "BUSY_TURN", ROLLBACK_BUSY_MESSAGE));
        return;
    }
    // PRE-REVERT capture — thread/revert destroys the removed tail:
    let read = match client.read_thread(&thread_id, true).await {
        Ok(v) => v,
        Err(err) => { reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", &err.to_string())); return; }
    };
    let raw_turns = read.get("thread").and_then(|t| t.get("turns")).and_then(Value::as_array).cloned().unwrap_or_default();
    let (before_turn_id, removed) = match resolve_codex_boundary(&raw_turns, op.mode, op.turn_id.as_deref()) {
        Ok(v) => v,
        Err(CodexRollbackError::NothingToUndo) => { reply_sink(rollback_error_frame(&op, "NOTHING_TO_UNDO", UNDO_EMPTY_MESSAGE)); return; }
        Err(CodexRollbackError::TargetNotFound) => { reply_sink(rollback_error_frame(&op, "INVALID_ROLLBACK_TARGET", &format!("turn {:?} is not in this thread's history", op.turn_id))); return; }
    };
    let removed_ids: Vec<String> = removed.iter().filter_map(|t| t.get("turnId").or_else(|| t.get("id")).and_then(Value::as_str).map(str::to_string)).collect();
    let prompt = removed.iter().find(|t| t.get("role").and_then(Value::as_str) == Some("user")).map(codex_turn_plain_text).unwrap_or_default();
    // Durable record FIRST (durable-BEFORE-mutation, wire design): the post-op record is computed
    // from the pre-revert read, then AWAITED. A failed write REFUSES the rollback — provider
    // history is never mutated. (Append-only entries for codex; the stored can_redo stays false.)
    let now = crate::rollback_record::now_ms(); // reuse this file's timestamp helper; else SystemTime now_ms
    let previous = self.identity_sink.as_ref().and_then(|s| s.load_rollback("codex", &thread_id));
    // Epoch rule (r3): an undo landing while redo_destroyed is set starts a NEW epoch —
    // ONLY the redo-capable chain state resets (`redo_destroyed` clears — the record's redo
    // state now describes the new chain; the prior chain's redo stays permanently dead);
    // `entries` is NEVER cleared (the union of every epoch's markers persists — codex
    // thread/revert destroyed the old tail, so the ledger is their only home, decision 6).
    let mut record = match previous.clone() {
        Some(p) => { let mut p = p; if p.redo_destroyed { p.redo_destroyed = false; } p }
        _ => RollbackRecord::empty(now),
    };
    record.push_entry(RollbackEntry { removed_turns: removed, prompt_text: prompt.clone(), at_ms: now }, now);
    record.set_can_redo(false, now); // codex is undo-only (decision 5)
    if let Some(sink) = self.identity_sink.clone() {
        if let Err(e) = sink.record_rollback("codex", &thread_id, record).await {
            tracing::warn!(error = %e, session = %thread_id, "freshagent.codex.rollback_pre_write_failed");
            reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", LEDGER_WRITE_REFUSAL_COPY));
            return;
        }
    }
    if let Err(err) = client.revert_thread(&thread_id, &before_turn_id).await {
        // Compensate ONLY on explicit RPC-rejection legs (errorkind Rpc: the provider
        // ANSWERED with a JSON-RPC error, so the revert provably did not apply);
        // transport/unknown legs (Timeout/Closed/Transport — the provider may have
        // applied) KEEP the post-op ledger + answer INTERNAL_ERROR (review M3).
        if matches!(&err, CodexAppServerError::Rpc { .. }) {
            // Compensating write FIRST (the ledger must not describe a rollback the provider rejected):
            if let Some(sink) = self.identity_sink.clone() {
                let restore = previous.unwrap_or_else(|| RollbackRecord::empty(now));
                if let Err(e) = sink.record_rollback("codex", &thread_id, restore).await {
                    tracing::warn!(error = %e, session = %thread_id, "freshagent.codex.rollback_compensate_failed");
                }
            }
            let msg = err.to_string();
            if msg.contains("-32600") && msg.contains("only supports paginated threads") {
                reply_sink(rollback_error_frame(&op, "UNSUPPORTED_CAPABILITY", CODEX_LEGACY_THREAD_COPY));
            } else if msg.contains("-32601") || msg.to_ascii_lowercase().contains("method not found") {
                // unknown-method / missing `thread/revert` shape => the CLI predates the surface
                reply_sink(rollback_error_frame(&op, "UNSUPPORTED_CAPABILITY", CODEX_OLD_CLI_COPY));
            } else {
                reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", &msg));
            }
        } else {
            // Possibly-applied mutation: the ledger is KEPT (never compensated) and the
            // refusal answers INTERNAL_ERROR + CODEX_UNCERTAIN_ROLLBACK_COPY ("Undo state
            // could not be confirmed — conversation and undo history may disagree until
            // the next refresh.").
            reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", CODEX_UNCERTAIN_ROLLBACK_COPY));
        }
        return;
    }
    // Converge siblings + revoke attention (decisions 6/10). NEVER a turn.complete (no chime).
    self.broadcast(&rollback_broadcast_frame(&op, &thread_id, &removed_ids, false));
    reply_sink(rollback_ack_frame(&op, &thread_id, Some(&prompt), &removed_ids, false, None));
}
```

`handle_send` (codex.rs:1079) — after the `ensure_session_alive` prologue and the session lookup (so `session_id` is resolved), before `client.start_turn`. The r2 busy-truth discipline: `handle_send` takes the session's `turn_lock` and SETS `active_turn` UNDER it BEFORE the `turn/start` write goes out (closing the check-then-set window against `handle_rollback`'s busy check); `handle_send` NEVER acquires or consults `rollback_in_flight` — while a rollback holds the turn lock the send simply waits on the lock, then proceeds and destroys redo (deterministic serialization; no circular wait). Then:

```rust
// Decision 5 (codex/opencode/claude share this helper): any new submission destroys redo.
let _ = crate::rollback_record::destroy_redo_on_submit(&self.identity_sink, "codex", &session_id, now_ms).await;
```

Add to `crates/freshell-freshagent/src/rollback_record.rs`:

```rust
/// Decision 5: any new submission (send/steer/queue firing) permanently destroys
/// redo — the redo-capable CHAIN STATE only; `entries` (the r3 marker union) is
/// NEVER touched and survives with the "rolled back" marker per decision 6.
/// AWAITED before the prompt goes out. A write failure is
/// returned — callers `tracing::warn!` it but never block the send and never emit a
/// user-facing event (providers degrade gracefully: opencode natively deletes the
/// reverted tail on send; claude's redo path re-validates the recorded tip).
pub async fn destroy_redo_on_submit(
    sink: &Option<SharedPaneIdentitySink>,
    provider: &str,
    live_id: &str,
    now_ms: i64,
) -> Option<std::io::Error> {
    let sink = sink.as_ref()?;
    let mut record = sink.load_rollback(provider, live_id)?;
    if record.redo_destroyed || (record.entries.is_empty() && record.original_session_id.is_none()) {
        return None;
    }
    record.destroy_redo(now_ms); // sets redo_destroyed + clears can_redo; entries untouched (r3)
    sink.record_rollback(provider, live_id, record).await.err()
}
```

`crates/freshell-ws/src/terminal.rs` — replace the Task-1 codex undo refusal with dispatch (codex redo keeps its permanent refusal):

```rust
ClientMessage::FreshAgentUndo(m) => {
    if is_codex_provider(m.provider) {
        let fresh_codex = state.fresh_codex.clone();
        let conn_sink = conn_sink.clone();
        tokio::spawn(async move { fresh_codex.handle_rollback(RollbackRequest::from_undo(m), conn_sink).await }.instrument(tracing::Span::current()));
    } else {
        conn_sink(rollback_refusal_frame(&RollbackRequest::from_undo(m), "Undo is"));
    }
    true
}
// ClientMessage::FreshAgentRedo: unchanged Task-1 refusal arm for now.
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-codex --test app_server_drive && cargo test -p freshell-freshagent codex::tests`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Extract the duplicated ensure-alive prologue between `handle_fork`/`handle_rollback` ONLY if the closure shape stays identical to fork's (replies keyed on resolved id); if the two legs' reply shapes diverge meaningfully, keep the duplication and note why. Confirm `resolve_codex_boundary`'s Step/toTurn index math reads cleanly (Step ⇒ last index; toTurn ⇒ position) — simplify the dead `unreachable!()` scaffolding from the plan draft. No behavior change.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the whole codex lane (all in-file codex tests incl. fork/send/snapshot), the codex crate suite, and the WS dispatch surface.

Run: `cargo test -p freshell-codex && cargo test -p freshell-codex --features real-transport && cargo test -p freshell-freshagent codex && cargo test -p freshell-ws && cargo clippy -p freshell-codex -p freshell-freshagent --all-targets -- -D warnings && cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-codex/src/app_server.rs crates/freshell-codex/tests/app_server_drive.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/rollback_record.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/freshagent_rollback_refusal.rs
git commit -m "feat(fresh-codex): undo-only conversation rollback via thread/revert (kata 1wxv task 2)"
```

---

### Task 3: Opencode undo/redo leg (`revert`/`unrevert`, stepwise redo by re-revert)

**Stage-2 binding amendments (from "## Load-bearing corrections", item 2):**
- Verified `revert` field shape (REPLACES any different sample nesting in this task): top-level on the session body — `session.revert = { "messageID": string, "snapshot"?: ..., "diff"?: ..., "partID"?: string }`, omitted entirely when no rollback is active. The serve fake and the read path use exactly this.
- The served message LIST returns reverted tail rows UNFLAGGED. `build_opencode_snapshot_json` (and its per-message projection) computes the ACTIVE PREFIX as messages strictly before `revert.messageID`; the tail beyond the pointer is projected as `rolledBackTurns` markers for Task 5 (never from freshell guessing).
- Undo/redo targets name USER message ids; an assistant-message id normalizes to its parent user message (serve-verified). Unknown messageID is a silent 200 no-op — the handler must post-verify by re-reading the session and treating "pointer didn't move" as `INVALID_ROLLBACK_TARGET`.
- Any subsequent send/command/summarize natively DELETES the reverted tail rows (kills that chain's redo — matches decision 5) while freshell's ledger REMAINS the durable marker source (r3: the deleted rows' markers persist in the ledger union — do not try to preserve them PROVIDER-side, and never drop them freshell-side). The handler's `destroy_redo_on_submit` covers our side.
- **Binding (decision 1 keeps force):** the freshopencode serve sidecar launches with opencode snapshots DISABLED in the managed config (probe-verified that native revert re-applies patch files otherwise). Add to this task's Steps: revert of a patch-carrying turn leaves the working tree byte-identical (hash before/after). If disabling snapshots turns out to also disable revert entirely, the alternative is NOT falling back to file-touching: it is emulating via fork-at-point (opencode fork is message-targeted, serve.rs:748-770) — but only snapshots-off probing decides.
- Empty-prefix (revert of the first user message) is legal: active prefix empties; no first-turn refusal exists for opencode; only `NOTHING_TO_UNDO` on empty active prefix.

**Files:**
- Modify: `crates/freshell-opencode/src/serve.rs` (`revert` + `unrevert` client methods beside `fork` at :741-770, exact-body discipline; AND the managed `opencode serve` process launch owned by `OpencodeServeManager` — the spawn site freshell uses to start the fresh-agent serve sidecar: the managed config written for fresh-agent sessions DISABLES opencode snapshots, so native revert can never re-apply files — decision 1 keeps force; stage-2 probe-verified that snapshot-enabled revert re-applies patch files)
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (`FreshOpencodeState` gains `rollback_in_flight: crate::InFlightRegistry` (rollback-vs-rollback only — the registry does NOT grow send-path legs under the r2 lock discipline); `handle_rollback` acquires `rollback_in_flight` FIRST and then holds the per-session mutex across the whole op; `handle_send` NEVER acquires/consults the registry — it simply waits on the same mutex — and destroys redo at :626-627)
- Modify: `crates/freshell-freshagent/src/lib.rs` (extract the per-message turn projection out of `build_opencode_snapshot_json`'s loop into a reusable `pub(crate) fn` AND the functional active-prefix/tail-marker filter — r2, this task's builder change is no longer a pure refactor)
- Modify: `crates/freshell-ws/src/terminal.rs` (opencode undo+redo arms route to `handle_rollback`)
- Modify: `crates/freshell-ws/tests/freshagent_rollback_refusal.rs` (opencode×undo and opencode×redo cases removed — real dispatch now)
- Test: `crates/freshell-freshagent/src/opencode_ws.rs` (in-file tests; `RollbackFakeHttp` mirrors `ForkFakeHttp` at :4231+), `crates/freshell-opencode` (serve-launch test asserting the managed config carries the disabled-snapshot setting, per that crate's existing spawn-test idiom)

**Interfaces:**
- Consumes: `OpencodeServeManager::get_session` / `list_messages` / `json_request` (`serve.rs`), `Route` + `with_route` serve.rs:1037, `changed_event` (`opencode_ws.rs:1713-1715`), the Task 1 rollback_record surface, `FreshOpencodeState.fork_in_flight` idiom (`opencode_ws.rs:124-129`), `ForkFakeHttp` + `fork_msg` + `capturing_sink` test idioms (`opencode_ws.rs:4199-4270`).
- Produces:
  - `OpencodeServeManager::revert(&self, id: &str, message_id: &str, route: &Route) -> Result<(), ServeError>` — `POST /session/{id}/revert` body exactly `{"messageID": <id>}`.
  - `OpencodeServeManager::unrevert(&self, id: &str, route: &Route) -> Result<(), ServeError>` — `POST /session/{id}/unrevert`, no body.
  - The managed serve launch writes a config for fresh-agent sessions with opencode snapshots DISABLED (pin the vendored CLI's verified config key in the commit message; the Task 7 byte-identical-tree e2e assertion is the behavioral arbiter).
  - `FreshOpencodeState::handle_rollback(&self, op: RollbackRequest, reply_sink: FrameSink)`.
  - `pub(crate) fn opencode_message_turn_json(msg: &Value) -> Value` — the one-message turn projection factored out of `build_opencode_snapshot_json` (lib.rs:1384-1429), call sites unchanged.
  - `InFlightRegistry` — UNCHANGED under the r2 lock discipline (`try_acquire` only; `handle_send` never consults it — the per-session mutex is the sole send-side wait point, so no `is_in_flight`/`wait_for` legs are added).
  - Turn math contract: the serve session's top-level `revert.messageID` (when present — the VERIFIED shape is `session.revert = {messageID, snapshot?, diff?, partID?}` top-level on the session body, omitted when inactive; no `info.revert` exists anywhere) is the FIRST removed message. Active prefix = messages strictly before it; the message LIST returns the reverted tail UNFLAGGED (never hidden). Undo Step target = last `role=="user"` message of the active prefix; the revert removes target-and-after within the active prefix. Redo Step: from the removed tail, move the boundary forward one USER step — `revert{messageID: <next user message strictly after the current pointer>}`, or `unrevert` when no such user message exists (all-or-nothing restore). Redo toTurn(turnId=T) restores through T's group: `revert{messageID: <first user message strictly after T>}` or `unrevert`. A message id must match `^msg` and sit inside the addressed range (active prefix for undo, removed tail for redo), else `INVALID_ROLLBACK_TARGET` from the handler.
  - Post-op discipline (all legs): compute the POST-OP record from the pre-mutation reads → AWAIT-write it BEFORE the mutation (failure ⇒ `INTERNAL_ERROR` + `LEDGER_WRITE_REFUSAL_COPY`, history never mutated) → mutate (`revert`/`unrevert`) → POST-VERIFY by re-reading the session — classified as the r3 TRIAD (NEVER a compensating rewrite after a possibly-applied mutation): (a) the read SUCCEEDS and the observed pointer equals exactly the requested boundary (or is ABSENT after a full `unrevert`) ⇒ success; (b) the read SUCCEEDS and the pointer provably did NOT move (the silent-200 no-op: unknown/stale messageID — the verified rule is pointer-untouched on no-op, so the provider is provably unmoved) ⇒ `INVALID_ROLLBACK_TARGET` + compensating rewrite of the pre-op record; (c) the read ITSELF FAILED (transport/5xx — the mutation may have applied) ⇒ `INTERNAL_ERROR`, the ledger is KEPT (no compensation — it may describe the truth), and the retry/reconciliation note: the next snapshot derives the prefix from provider rows, so pane + record reconverge automatically. The mutation-RPC error legs (revert-route 404/unknown route ⇒ `UNSUPPORTED_CAPABILITY` + `OPENCODE_OLD_CLI_COPY`; other transport failures ⇒ `INTERNAL_ERROR`) PROVABLY did not apply and compensate as before. The same triad governs the REDO path.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-freshagent/src/opencode_ws.rs` — in the fork-tests module:

```rust
// ── freshAgent.undo / freshAgent.redo (kata 1wxv Task 3) ────────────────

/// The rollback-suite serve fake: records EVERY request; scripts session info with a
/// TOP-LEVEL `revert` pointer (the VERIFIED wire shape — never `info.revert`) and a
/// fixed two-or-three-turn message list that is returned IN FULL at all times (the
/// real serve returns the reverted tail UNFLAGGED; freshell computes the active prefix).
struct RollbackFakeHttp {
    requests: StdMutex<Vec<RecordedRequest>>,
    revert_pointer: StdMutex<Option<String>>, // session.revert.messageID (TOP-LEVEL on the session body)
    revert_status: StdMutex<u16>,             // 200 default; 404 simulates a CLI predating the route
    revert_moves_pointer: StdMutex<bool>,     // false simulates the silent-200 no-op (unknown/stale messageID)
}

impl RollbackFakeHttp {
    fn three_turn_json() -> Value {
        json!([
            { "info": { "id": "msg_u1", "role": "user" }, "parts": [{ "type": "text", "text": "prompt one" }] },
            { "info": { "id": "msg_a1", "role": "assistant" }, "parts": [{ "type": "text", "text": "answer one" }] },
            { "info": { "id": "msg_u2", "role": "user" }, "parts": [{ "type": "text", "text": "prompt two" }] },
            { "info": { "id": "msg_a2", "role": "assistant" }, "parts": [{ "type": "text", "text": "answer two" }] },
            { "info": { "id": "msg_u3", "role": "user" }, "parts": [{ "type": "text", "text": "prompt three" }] },
            { "info": { "id": "msg_a3", "role": "assistant" }, "parts": [{ "type": "text", "text": "answer three" }] },
        ])
    }
    // ServeHttp impl mirrors ForkFakeHttp exactly: record every request; route
    // GET /session/<id> => { "id": ..., "revert": pointer.map(|m| json!({"messageID": m})) }-shaped body
    // (the `revert` key is TOP-LEVEL and omitted entirely when the pointer is None),
    // GET /session/<id>/message => three_turn_json() ALWAYS (never post-filtered — the reverted
    // tail is returned unflagged), POST revert => on revert_status 200 + moves_pointer, set the
    // pointer to the body messageID, POST unrevert => clear the pointer; revert_status drives the
    // HTTP status (404 => old-CLI simulation).
    // (Copy the ForkFakeHttp request-recording harness verbatim and extend the router;
    // do NOT build a second recording style.)
}

fn undo_op(session_id: &str, request_id: &str) -> RollbackRequest {
    RollbackRequest { direction: RollbackDirection::Undo, mode: RollbackModeReq::Step, turn_id: None,
        session_id: session_id.into(), session_type: SessionType::Freshopencode,
        provider: AgentProvider::Opencode, request_id: request_id.into(), cwd: None }
}

#[tokio::test(start_paused = true)]
async fn handle_rollback_step_reverts_at_the_last_user_message_and_refills() {
    // Register a materialized session ("ses_real") over RollbackFakeHttp with no revert pointer.
    // `state_with_rollback_fake` mirrors `state_with_durable_serve_session` (opencode_ws.rs:2883)
    // and returns (state, broadcast_rx, fake_sink, fake_http) so tests reach both:
    let (st, mut rx, st_sink, http) = state_with_rollback_fake(None).await;
    let (sink, captured) = capturing_sink();
    st.handle_rollback(undo_op("ses_real", "rb-1"), sink).await;

    let frames = captured_frames(&captured);
    assert_eq!(frames.len(), 1, "one ack: {frames:?}");
    assert_eq!(frames[0]["event"]["type"], json!("freshAgent.rolledBack"));
    assert_eq!(frames[0]["event"]["removedPromptText"], json!("prompt three"));
    assert_eq!(frames[0]["event"]["canRedo"], json!(true));
    let recorded = http.recorded();
    let revert = recorded.iter().find(|r| r.method == "POST" && r.url.contains("/revert") && !r.url.contains("/unrevert"))
        .expect("one revert POST");
    assert_eq!(revert.body_json(), json!({ "messageID": "msg_u3" }), "Step targets the last USER message of the active prefix");
    // Broadcast: session.changed invalidation + session.rolledBack (revokeAttention), no turn.complete:
    let mut saw_changed = false;
    let mut saw_rolledback = false;
    while let Ok(raw) = rx.try_recv() {
        let v: Value = serde_json::from_str(&raw).expect("broadcast json");
        assert_ne!(v["event"]["type"], json!("freshAgent.turn.complete"), "rollback never chimes");
        saw_changed |= v["event"]["type"] == json!("freshAgent.session.changed");
        if v["event"]["type"] == json!("freshAgent.session.rolledBack") {
            saw_rolledback = true;
            assert_eq!(v["event"]["revokeAttention"], json!(true));
            assert_eq!(v["event"]["canRedo"], json!(true));
        }
    }
    assert!(saw_changed && saw_rolledback, "invalidation + convergence broadcasts fired");
    // The durable record is rebuilt to exactly the current revert tail:
    let record = st_sink.load_rollback("opencode", "ses_real").expect("record");
    assert_eq!(record.entries.len(), 1);
    assert_eq!(record.entries[0].prompt_text, "prompt three");
    assert_eq!(record.entries[0].removed_turns.len(), 2, "msg_u3 + msg_a3 marked");
}

#[tokio::test(start_paused = true)]
async fn handle_rollback_to_turn_removes_n_turns_in_one_revert_call() {
    let (st, _rx, _sink, http) = state_with_rollback_fake(None).await;
    let (sink, captured) = capturing_sink();
    let mut op = undo_op("ses_real", "rb-2");
    op.mode = RollbackModeReq::ToTurn;
    op.turn_id = Some("msg_u2".into());
    st.handle_rollback(op, sink).await;
    let reverts: Vec<_> = http.recorded().into_iter().filter(|r| r.method == "POST" && r.url.ends_with("/revert")).collect();
    assert_eq!(reverts.len(), 1, "undo-to-here is ONE revert, never N round trips (decision 3)");
    assert_eq!(reverts[0].body_json(), json!({ "messageID": "msg_u2" }));
    let frames = captured_frames(&captured);
    assert_eq!(frames[0]["event"]["removedPromptText"], json!("prompt two"));
    assert_eq!(frames[0]["event"]["removedTurnIds"].as_array().expect("ids").len(), 4, "two turns away: msg_u2..msg_a3");
}

#[tokio::test(start_paused = true)]
async fn handle_rollback_redo_step_moves_the_boundary_forward_by_one_user_step() {
    // Pointer at msg_u2 (msg_u2..msg_a3 rolled back); one redo step restores msg_u2+msg_a2.
    let (st, _rx, st_sink, http) = state_with_rollback_fake(Some("msg_u2")).await;
    let (sink, captured) = capturing_sink();
    let mut op = undo_op("ses_real", "rb-3");
    op.direction = RollbackDirection::Redo;
    st.handle_rollback(op, sink).await;
    let reverts: Vec<_> = http.recorded().into_iter().filter(|r| r.method == "POST" && r.url.ends_with("/revert")).collect();
    assert_eq!(reverts.len(), 1);
    assert_eq!(reverts[0].body_json(), json!({ "messageID": "msg_u3" }), "stepwise redo = re-revert to the NEXT user message (decision 5)");
    let frames = captured_frames(&captured);
    assert_eq!(frames[0]["event"]["type"], json!("freshAgent.redone"));
    assert_eq!(frames[0]["event"]["restoredThroughTurnId"], json!("msg_a2"));
    assert_eq!(frames[0]["event"]["canRedo"], json!(true), "msg_u3+msg_a3 are still rolled back");
    let record = st_sink.load_rollback("opencode", "ses_real").expect("record");
    assert_eq!(record.entries.len(), 1);
    assert_eq!(record.entries[0].removed_turns.len(), 2, "the marker bucket was rebased to the remaining tail");
}

#[tokio::test(start_paused = true)]
async fn handle_rollback_redo_full_restore_uses_unrevert() {
    // Pointer at msg_u3 — the only removed user step: full restore is the all-or-nothing unrevert.
    let (st, _rx, st_sink, http) = state_with_rollback_fake(Some("msg_u3")).await;
    let (sink, captured) = capturing_sink();
    let mut op = undo_op("ses_real", "rb-4");
    op.direction = RollbackDirection::Redo;
    st.handle_rollback(op, sink).await;
    assert!(http.recorded().iter().any(|r| r.method == "POST" && r.url.contains("/unrevert")), "all-or-nothing redo = POST unrevert");
    let frames = captured_frames(&captured);
    assert_eq!(frames[0]["event"]["canRedo"], json!(false));
    let record = st_sink.load_rollback("opencode", "ses_real").expect("record");
    assert!(record.entries.is_empty(), "nothing rolled back remains");
}

#[tokio::test(start_paused = true)]
async fn handle_rollback_redo_after_destroy_is_redo_unavailable_and_never_posts() {
    let (st, _rx, st_sink, http) = state_with_rollback_fake(Some("msg_u2")).await;
    st_sink.record_rollback("opencode", "ses_real", {
        let mut r = RollbackRecord::empty(1);
        r.redo_destroyed = true;
        r.last_op_at_ms = 2;
        r
    }).await.expect("seed");
    let (sink, captured) = capturing_sink();
    let mut op = undo_op("ses_real", "rb-5");
    op.direction = RollbackDirection::Redo;
    st.handle_rollback(op, sink).await;
    let frames = captured_frames(&captured);
    assert_eq!(frames[0]["event"]["code"], json!("REDO_UNAVAILABLE"));
    assert_eq!(frames[0]["event"]["message"], json!(REDO_DESTROYED_MESSAGE));
    assert!(http.recorded().iter().all(|r| !(r.method == "POST" && r.url.contains("revert"))), "destroyed redo issues ZERO POSTs");
}

#[tokio::test(start_paused = true)]
async fn handle_rollback_mid_turn_is_busy() {
    // Session whose turn_task is unfinished (mirror the compact-busy rig at opencode_ws.rs:607-621).
    let (st, _rx, _sink, http) = state_with_rollback_fake_busy_turn().await;
    let (sink, captured) = capturing_sink();
    st.handle_rollback(undo_op("ses_real", "rb-6"), sink).await;
    let frames = captured_frames(&captured);
    assert_eq!(frames[0]["event"]["code"], json!("BUSY_TURN"));
    assert_eq!(frames[0]["event"]["message"], json!(ROLLBACK_BUSY_MESSAGE));
    assert!(http.recorded().is_empty(), "busy rollback issues ZERO HTTP calls");
}

#[tokio::test(start_paused = true)]
async fn handle_rollback_placeholder_session_is_lost_session_shape() {
    let (st, _rx, _sink, _http) = state_with_rollback_fake(None).await; // variant: unmaterialized "freshopencode-x" placeholder
    let (sink, captured) = capturing_sink();
    st.handle_rollback(undo_op("freshopencode-placeholder-1", "rb-7"), sink).await;
    let frames = captured_frames(&captured);
    assert_eq!(frames[0]["event"]["code"], json!("INVALID_SESSION_ID"));
    assert!(frames[0]["event"]["message"].as_str().unwrap_or_default().contains("has not materialized; cannot roll back."));
}

#[tokio::test(start_paused = true)]
async fn handle_rollback_twice_keeps_markers_in_conversation_order() {
    // Undo (removes the msg_u3 group), then undo again (removes the msg_u2 group):
    // the marker bucket is the tail in its ORIGINAL CONVERSATION ORDER [u2,a2,u3,a3] —
    // never wire order [u3,a3,u2,a2].
    let (st, _rx, st_sink, _http) = state_with_rollback_fake(None).await;
    let (sink, _captured) = capturing_sink();
    st.handle_rollback(undo_op("ses_real", "rb-8a"), sink).await;
    let (sink2, _captured2) = capturing_sink();
    st.handle_rollback(undo_op("ses_real", "rb-8b"), sink2).await;
    let record = st_sink.load_rollback("opencode", "ses_real").expect("record");
    let ids: Vec<&str> = record.entries[0].removed_turns.iter().filter_map(|t| t["turnId"].as_str()).collect();
    assert_eq!(ids, vec!["msg_u2", "msg_a2", "msg_u3", "msg_a3"], "markers follow the tail's conversation order");
}

#[tokio::test(start_paused = true)]
async fn handle_rollback_silent_noop_revert_is_invalid_target() {
    // Triad leg (b) (r3): revert 200s and the post-verify read SUCCEEDS but the pointer
    // provably did NOT move (unknown/stale messageID simulation — the verified silent-200
    // rule is pointer-untouched-on-no-op, so the provider is provably unmoved): the
    // post-verify catches it => INVALID_ROLLBACK_TARGET, and the record
    // was compensated back (the ledger never describes a rollback the serve provably rejected).
    let (st, _rx, st_sink, http) = state_with_rollback_fake(None).await;
    *http.revert_moves_pointer.lock().expect("flag") = false;
    let (sink, captured) = capturing_sink();
    st.handle_rollback(undo_op("ses_real", "rb-9"), sink).await;
    let frames = captured_frames(&captured);
    assert_eq!(frames[0]["event"]["code"], json!("INVALID_ROLLBACK_TARGET"));
    assert!(st_sink.load_rollback("opencode", "ses_real").map(|r| r.entries.is_empty()).unwrap_or(true),
        "the pre-written record was compensated away");
}

#[tokio::test(start_paused = true)]
async fn handle_rollback_post_verify_READ_failure_keeps_the_ledger_and_reports_internal_error() {
    // Triad leg (c) (r3, undo + redo): the revert/unrevert POST 200s, but the post-verify
    // get_session READ FAILS (transport/5xx — the mutation may have applied). Assert:
    // exactly one frame, INTERNAL_ERROR (never INVALID_ROLLBACK_TARGET); NO compensating
    // rewrite issued (the pre-written post-op record is still in the sink verbatim — a
    // compensate after a possibly-applied mutation would falsify the ledger); and a code
    // comment in the handler records the reconvergence note: the next snapshot derives its
    // prefix from provider rows, so pane + record reconverge automatically on retry.
    // (RollbackFakeHttp gains a fail_next_get_session flag for this.)
    // Redo leg: same rig with a seeded pointer + record; the failed read after a re-revert
    // yields the same INTERNAL_ERROR + ledger-kept outcome.
}

#[tokio::test(start_paused = true)]
async fn handle_rollback_revert_404_is_unsupported_capability() {
    let (st, _rx, _sink, http) = state_with_rollback_fake(None).await;
    *http.revert_status.lock().expect("status") = 404; // CLI predates the revert route
    let (sink, captured) = capturing_sink();
    st.handle_rollback(undo_op("ses_real", "rb-10"), sink).await;
    let frames = captured_frames(&captured);
    assert_eq!(frames[0]["event"]["code"], json!("UNSUPPORTED_CAPABILITY"));
    assert_eq!(frames[0]["event"]["message"], json!(OPENCODE_OLD_CLI_COPY));
}

#[tokio::test(start_paused = true)]
async fn handle_rollback_revert_transport_failure_is_internal_error() {
    // Fake serves a non-404 5xx on revert: only unknown transport/other failures map to
    // INTERNAL_ERROR (never an uncontextualized 404, never an unclassified -32600 class).
    let (st, _rx, _sink, http) = state_with_rollback_fake(None).await;
    *http.revert_status.lock().expect("status") = 500;
    let (sink, captured) = capturing_sink();
    st.handle_rollback(undo_op("ses_real", "rb-11"), sink).await;
    let frames = captured_frames(&captured);
    assert_eq!(frames[0]["event"]["code"], json!("INTERNAL_ERROR"));
    assert_ne!(frames[0]["event"]["message"], json!(OPENCODE_OLD_CLI_COPY));
}

#[tokio::test(start_paused = true)]
async fn handle_rollback_record_write_failure_refuses_and_never_posts_revert() {
    // Durable-BEFORE-mutation: the record pre-write fails => INTERNAL_ERROR +
    // LEDGER_WRITE_REFUSAL_COPY and NO revert/unrevert POST is ever issued.
    let (st, _rx, st_sink, http) = state_with_rollback_fake(None).await;
    st_sink.set_fail_writes(true); // FakeIdentitySink write-failure flag (Task 1 fake surface)
    let (sink, captured) = capturing_sink();
    st.handle_rollback(undo_op("ses_real", "rb-12"), sink).await;
    let frames = captured_frames(&captured);
    assert_eq!(frames[0]["event"]["code"], json!("INTERNAL_ERROR"));
    assert_eq!(frames[0]["event"]["message"], json!(LEDGER_WRITE_REFUSAL_COPY));
    assert!(http.recorded().iter().all(|r| !(r.method == "POST" && r.url.contains("revert"))),
        "provider history is never mutated once the record cannot be saved");
}

#[tokio::test(start_paused = true)]
async fn handle_send_issued_mid_rollback_strictly_follows_it() {
    // Pinned semantic (send waits; rollback wins; then the send destroys redo) under the r2
    // lock discipline: the per-session mutex is held across the whole rollback handler, and
    // handle_send NEVER acquires/consults rollback_in_flight — its ONLY wait point is that
    // same mutex, so a send issued while a rollback is in flight blocks behind it with no
    // circular wait. Script a SLOW revert response; start handle_rollback; fire handle_send
    // mid-flight; assert the recorded request order shows the revert POST AND its
    // post-verify GET strictly BEFORE the prompt POST (deterministic serialization), and
    // that the final record carries redo_destroyed applied to the POST-ROLLBACK state.
    let (st, _rx, st_sink, http) = state_with_rollback_fake_slow_revert(None).await;
    let rollback = { let st = st.clone(); tokio::spawn(async move { st.handle_rollback(undo_op("ses_real", "rb-13"), capturing_sink().0).await }) };
    let send = { let st = st.clone(); tokio::spawn(async move { st.handle_send(/* the file's existing send-test payload idiom */).await }) };
    // Bounded completion == no deadlock between the two handlers' lock waits:
    tokio::time::timeout(std::time::Duration::from_secs(5), tokio::join!(rollback, send)).await
        .expect("send+rollback must serialize, never deadlock");
    let order: Vec<&str> = http.recorded().iter().map(|r| r.url_suffix()).collect();
    let revert_pos = order.iter().position(|u| u.ends_with("/revert")).expect("revert happened");
    let prompt_pos = order.iter().position(|u| u.contains("/message")).expect("prompt happened");
    assert!(revert_pos < prompt_pos, "the send strictly follows the rollback — never concurrent");
    assert!(st_sink.load_rollback("opencode", "ses_real").expect("record").redo_destroyed,
        "the trailing send destroyed redo on the post-rollback record (decision 5)");
}

#[tokio::test(start_paused = true)]
async fn handle_rollback_after_a_resend_starts_a_new_epoch_and_redo_still_works() {
    // r3 epoch rule end-to-end on this lane: undo (removes the msg_u3 group) → resend the
    // edited prompt (the fake's /message arm natively DELETES the reverted tail rows and
    // clears the pointer, mirroring decision-5 native behavior; destroy_redo_on_submit sets
    // redo_destroyed) → undo AGAIN (removes the resent turn) → redo. Assert: after the
    // second undo the marker bucket is the UNION — the old u3-group markers PERSIST as
    // frozen prior-epoch entries (their serve rows were natively deleted; the ledger is
    // their only home, decision 6) PRECEDING the newest epoch's markers in conversation
    // order; only the redo-capable chain state reset (redo available again for the NEW
    // chain: the prior chain's tail no longer exists, so its redo stays permanently dead);
    // and one redo step restores the newest epoch's removed tail (never the frozen rows).
    // (Extend RollbackFakeHttp's message store to track prompt appends + the native tail
    // deletion so this sequence is representable.)
}
```

`crates/freshell-freshagent/src/lib.rs` — in-file builder tests (append; the builder change in this task is FUNCTIONAL, not a pure refactor — these fail without the filter):

```rust
#[test]
fn opencode_snapshot_filters_turns_to_the_active_prefix_and_marks_the_tail() {
    // two-user+assistant sequence served in FULL — the tail UNFLAGGED, exactly like the
    // real provider; session.revert.messageID = the middle user message (top-level session
    // field; info.revert never exists). Assert turns[] == the active prefix ONLY (strictly
    // before the pointer) and rolledBackTurns == the tail rows in conversation order, each
    // stamped rolledBack:true. A regression to mapping every served message into turns[]
    // fails this test.
}

#[test]
fn opencode_snapshot_marker_order_is_stable_across_repeated_undos() {
    // revert the LAST user message, build; then revert the MIDDLE user message, build:
    // the second snapshot's rolledBackTurns order equals the surviving tail's conversation
    // order — never wire/undo order.
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent opencode_ws::tests::handle_rollback`

Expected: FAIL because `OpencodeServeManager::revert`/`unrevert` and `FreshOpencodeState::handle_rollback` don't exist (compile errors), the opencode arms still refuse at dispatch, and the managed serve launch does not yet write a snapshot-disabled config (the serve-launch assertion in `crates/freshell-opencode` fails too).

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-opencode/src/serve.rs` (after `fork`, :748-770):

```rust
/// `POST /session/:id/revert` (opencode 1.18.21) — message-targeted conversation
/// rollback: `{messageID}` marks that message and everything after it as reverted.
/// Body discipline mirrors `fork` (additionalProperties:false upstream): EXACTLY one key.
pub async fn revert(&self, id: &str, message_id: &std::primitive::str, route: &Route) -> Result<(), ServeError> {
    let path = with_route(&format!("/session/{}/revert", encode_path_segment(id)), route);
    self.json_request(HttpMethod::Post, &path, Some(json!({ "messageID": message_id })), None)
        .await?;
    Ok(())
}

/// `POST /session/:id/unrevert` — restores ALL reverted messages (all-or-nothing redo). No body.
pub async fn unrevert(&self, id: &str, route: &Route) -> Result<(), ServeError> {
    let path = with_route(&format!("/session/{}/unrevert", encode_path_segment(id)), route);
    self.json_request(HttpMethod::Post, &path, None, None).await?;
    Ok(())
}
```

`crates/freshell-freshagent/src/lib.rs`: extract `pub(crate) fn opencode_message_turn_json(msg: &Value) -> Value` from the `build_opencode_snapshot_json` (:1439-1495) message loop body; the loop now calls it. Then — a FUNCTIONAL change, NOT a pure refactor (r2): `build_opencode_snapshot_json` computes the ACTIVE PREFIX itself — messages strictly before the top-level `session.revert.messageID` (no `info.revert` exists anywhere) become `turns[]` (exactly what the model sees next); the tail rows at-or-after the pointer, which the serve returns UNFLAGGED, are projected as `rolledBackTurns` markers via the same per-message projection, stamped `rolledBack:true`, in conversation order. (Task 5 then layers the record-driven canRedo/undoneDepth on top; the tail the builder computes IS the rebuilt tail the record's entries describe, so the two sources agree by construction.)

`crates/freshell-freshagent/src/opencode_ws.rs`: struct field `rollback_in_flight: crate::InFlightRegistry` beside `fork_in_flight`, then:

```rust
pub async fn handle_rollback(&self, op: crate::rollback_record::RollbackRequest, reply_sink: FrameSink) {
    use crate::rollback_record::*;
    let Some(_guard) = self.rollback_in_flight.try_acquire(&op.session_id) else {
        reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", &format!("rollback already in progress for {}", op.session_id)));
        return;
    };
    let session_arc = { self.sessions.lock().await.get(&op.session_id).cloned() };
    let Some(session_arc) = session_arc else {
        reply_sink(rollback_error_frame(&op, "INVALID_SESSION_ID", &format!("OpenCode fresh-agent session {} is not available.", op.session_id)));
        return;
    };
    // The per-session mutex is HELD ACROSS THE ENTIRE HANDLER (busy check -> reads ->
    // record pre-write -> mutate -> post-verify read -> record write -> reply): no
    // mid-handler release. Lock ORDER under the r2 regime: rollback_in_flight (acquired
    // above, rollback-vs-rollback only) FIRST, then this mutex. handle_send NEVER
    // acquires/consults rollback_in_flight; it blocks on the same mutex, so a rollback
    // either fully precedes or fully follows any submission — never overlaps one, and no
    // circular wait exists (pinned semantic: send waits, rollback wins, then the trailing
    // send destroys redo).
    let session = session_arc.lock().await;
    let Some(real_id) = session.real_session_id.clone() else {
        reply_sink(rollback_error_frame(&op, "INVALID_SESSION_ID", &format!("OpenCode session {} has not materialized; cannot roll back.", session.placeholder_id)));
        return;
    };
    if session.turn_task.as_ref().is_some_and(|t| !t.is_finished()) {
        reply_sink(rollback_error_frame(&op, "BUSY_TURN", ROLLBACK_BUSY_MESSAGE));
        return;
    }
    let route = session.cwd.clone();
    if op.mode == RollbackModeReq::ToTurn && op.turn_id.is_none() {
        reply_sink(rollback_error_frame(&op, "INVALID_ROLLBACK_TARGET", "toTurn requires a turnId"));
        return;
    }
    let manager = self.fresh_agent.ensure_manager().await;
    let info = match manager.get_session(&real_id, &route).await { Ok(v) => v, Err(err) => { reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", &err.to_string())); return; } };
    let messages = match manager.list_messages(&real_id, &route).await { Ok(v) => v, Err(err) => { reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", &err.to_string())); return; } };
    // VERIFIED shape (correction item 2): `revert` is TOP-LEVEL on the session body —
    // session.revert = { messageID, snapshot?, diff?, partID? }, omitted when inactive.
    // No `info.revert` exists anywhere.
    let pointer: Option<String> = info.get("revert").and_then(|r| r.get("messageID")).and_then(Value::as_str).map(str::to_string);
    let boundary_idx = pointer.as_deref()
        .and_then(|p| messages.iter().position(|m| m["info"]["id"].as_str() == Some(p)))
        .unwrap_or(messages.len());
    let user_id_at = |range: &[Value], from_end: bool| -> Option<String> {
        let iter: Box<dyn Iterator<Item = &Value>> = if from_end { Box::new(range.iter().rev()) } else { Box::new(range.iter()) };
        iter.find(|m| m["info"]["role"].as_str() == Some("user")).and_then(|m| m["info"]["id"].as_str().map(str::to_string))
    };

    match op.direction {
        RollbackDirection::Undo => {
            let active = &messages[..boundary_idx];
            let target = match op.mode {
                RollbackModeReq::Step => match user_id_at(active, true) { Some(id) => id, None => { reply_sink(rollback_error_frame(&op, "NOTHING_TO_UNDO", UNDO_EMPTY_MESSAGE)); return; } },
                RollbackModeReq::ToTurn => {
                    let t = op.turn_id.clone().expect("validated above");
                    let target_row = active.iter().find(|m| m["info"]["id"].as_str() == Some(t.as_str()));
                    if !(t.starts_with("msg") && target_row.is_some()) {
                        reply_sink(rollback_error_frame(&op, "INVALID_ROLLBACK_TARGET", &format!("turn {t} is not in the active conversation")));
                        return;
                    }
                    // r3 pre-flight role refusal: the serve normalizes an assistant id to its
                    // parent USER message and GENUINELY applies the revert — freshell's removed
                    // slice would then exclude the parent turn, and the exact-pointer post-verify
                    // would read a MOVED pointer at the parent id, mis-firing the (b) silent-no-op
                    // compensation leg after an APPLIED mutation. USER rows only, refused BEFORE
                    // any ledger write or mutation.
                    if target_row.expect("membership checked")["info"]["role"].as_str() != Some("user") {
                        reply_sink(rollback_error_frame(&op, "INVALID_ROLLBACK_TARGET", &format!("turn {t} is not a user message; toTurn undo targets user turns only")));
                        return;
                    }
                    t
                }
            };
            let target_idx = active.iter().position(|m| m["info"]["id"].as_str() == Some(target.as_str())).expect("validated in range");
            let removed_msgs = &active[target_idx..];
            let removed_turns: Vec<Value> = removed_msgs.iter().map(crate::opencode_message_turn_json).collect();
            let removed_ids: Vec<String> = removed_msgs.iter().filter_map(|m| m["info"]["id"].as_str().map(str::to_string)).collect();
            let prompt = removed_msgs.iter().find(|m| m["info"]["role"] == "user")
                .and_then(|m| m["parts"].as_array()).map(|parts| parts.iter().filter(|p| p["type"] == "text").filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n\n")).unwrap_or_default();
            // Post-op record FIRST (durable-BEFORE-mutation): the marker bucket is the UNION
            // (r3) — FROZEN prior-epoch markers (recorded entries whose turn ids no longer
            // appear in the serve's message list: their tail rows were natively DELETED by a
            // resend, so the ledger is their only home, decision 6) PRECEDE the rebuilt
            // current-epoch tail in its ORIGINAL CONVERSATION ORDER — the newly removed
            // slice PRECEDES the prior current tail (undo 3 then undo 2 => markers [2,3]).
            // Epoch rule (r3): an undo landing while redo_destroyed is set starts a NEW
            // epoch that clears ONLY the redo-capable chain state — `redo_destroyed` clears
            // (the record's redo state now describes the NEW chain; the prior chain's redo
            // stays permanently dead because its provider tail no longer exists) — while
            // `entries` (the marker union) is NEVER cleared.
            let now = crate::rollback_record::now_ms();
            let previous = self.identity_sink.as_ref().and_then(|s| s.load_rollback("opencode", &real_id));
            let mut record = match previous.clone() {
                Some(p) => { let mut p = p; if p.redo_destroyed { p.redo_destroyed = false; } p }
                _ => RollbackRecord::empty(now),
            };
            // Frozen prior-epoch markers survive; only the CURRENT-epoch portion (turns still
            // present in the served message list) is rebuilt from the pointer-defined tail:
            //   frozen  = recorded marker turns whose ids are ABSENT from the served list;
            //   current = this op's newly removed slice ++ the still-served prior tail turns.
            let served_ids: std::collections::HashSet<&str> = messages.iter().filter_map(|m| m["info"]["id"].as_str()).collect();
            let old_turns: Vec<Value> = record.entries.drain(..).flat_map(|e| e.removed_turns).collect();
            let (frozen, current): (Vec<Value>, Vec<Value>) = old_turns.into_iter().partition(|t|
                t.get("turnId").or_else(|| t.get("id")).and_then(Value::as_str)
                    .map(|id| !served_ids.contains(id)).unwrap_or(true));
            let combined: Vec<Value> = frozen.into_iter().chain(removed_turns.into_iter().chain(current)).collect();
            record.entries = vec![RollbackEntry { prompt_text: prompt.clone(), removed_turns: combined, at_ms: now }];
            record.last_op_at_ms = now;
            record.set_can_redo(true, now);
            if let Some(sink) = self.identity_sink.clone() {
                if let Err(e) = sink.record_rollback("opencode", &real_id, record.clone()).await {
                    tracing::warn!(error = %e, session = %real_id, "freshagent.opencode.rollback_pre_write_failed");
                    reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", LEDGER_WRITE_REFUSAL_COPY));
                    return; // provider history NEVER mutated on this path
                }
            }
            if let Err(err) = manager.revert(&real_id, &target, &route).await {
                self.compensate_opencode_record(&real_id, previous.as_ref(), now).await;
                reply_sink(map_opencode_serve_error(&op, &err));
                return;
            }
            // POST-VERIFY (unknown/stale messageID is a silent 200 no-op serve-side) — the r3
            // triad; NEVER compensate after a possibly-applied mutation:
            let verified = match manager.get_session(&real_id, &route).await {
                Ok(v) => v.get("revert").and_then(|r| r.get("messageID")).and_then(Value::as_str).map(str::to_string),
                Err(err) => {
                    // (c) the READ failed (transport/5xx) — the revert may have applied: KEEP the
                    // ledger (no compensating rewrite) and report INTERNAL_ERROR. The next
                    // snapshot derives the active prefix from provider rows, so pane + record
                    // reconverge automatically on the client's retry/refetch.
                    reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", &format!("revert issued but the post-rollback verification read failed: {err}")));
                    return;
                }
            };
            if verified.as_deref() != Some(target.as_str()) {
                // (b) read SUCCEEDED and the pointer provably did not move (the verified
                // silent-200 rule is pointer-untouched-on-no-op) => provider PROVABLY unmoved:
                self.compensate_opencode_record(&real_id, previous.as_ref(), now).await;
                reply_sink(rollback_error_frame(&op, "INVALID_ROLLBACK_TARGET", "the serve accepted the revert but the rollback pointer did not move (unknown or stale messageID)"));
                return;
            }
            // (a) pointer observed == the requested boundary => success.
            let can_redo = record.can_redo();
            self.broadcast(&ServerMessage::FreshAgentEvent(changed_event_frame(&real_id))); // invalidation — see note
            self.broadcast(&rollback_broadcast_frame(&op, &real_id, &removed_ids, can_redo));
            reply_sink(rollback_ack_frame(&op, &real_id, Some(&prompt), &removed_ids, can_redo, None));
        }
        RollbackDirection::Redo => {
            let Some(p) = pointer else { reply_sink(rollback_error_frame(&op, "REDO_UNAVAILABLE", REDO_EMPTY_MESSAGE)); return; };
            let existing = self.identity_sink.as_ref().and_then(|s| s.load_rollback("opencode", &real_id));
            match existing.as_ref() {
                Some(r) if r.can_redo() => {}
                Some(r) if r.redo_destroyed => { reply_sink(rollback_error_frame(&op, "REDO_UNAVAILABLE", REDO_DESTROYED_MESSAGE)); return; }
                _ => { reply_sink(rollback_error_frame(&op, "REDO_UNAVAILABLE", REDO_EMPTY_MESSAGE)); return; }
            }
            let tail = &messages[boundary_idx..];
            if tail.is_empty() { reply_sink(rollback_error_frame(&op, "REDO_UNAVAILABLE", REDO_EMPTY_MESSAGE)); return; }
            // Uniform group math, one formula for both modes: Step restores the pointer's
            // own group (t_pos = 0); toTurn restores through T's group. Kept-through end =
            // the first USER message strictly AFTER the address; unrevert when none.
            // (r3: the rolled-back TAIL the pointer defines is the CURRENT epoch only —
            // frozen prior-epoch markers live in the ledger union, not in the served list,
            // so the tail math can never name them.)
            let t_pos = match op.mode {
                RollbackModeReq::Step => 0usize,
                RollbackModeReq::ToTurn => {
                    let t = op.turn_id.clone().expect("validated");
                    match tail.iter().position(|m| m["info"]["id"].as_str() == Some(t.as_str())) {
                        Some(pos) => pos,
                        None => { reply_sink(rollback_error_frame(&op, "INVALID_ROLLBACK_TARGET", &format!("turn {t} is not in the rolled-back tail"))); return; }
                    }
                }
            };
            let kept_end = messages.iter().enumerate().skip(boundary_idx + t_pos + 1).find(|(_, m)| m["info"]["role"] == "user").map(|(i, _)| i);
            let (restored_slice, new_boundary_id): (&[Value], Option<String>) = match kept_end {
                Some(i) => (&messages[boundary_idx..i], Some(messages[i]["info"]["id"].as_str().expect("id").to_string())),
                None => (&messages[boundary_idx..], None),
            };
            // Post-op record FIRST (durable-BEFORE-mutation): the marker bucket rebuilds to
            // the remaining tail BEFORE the revert/unrevert POST goes out — UNION rule (r3):
            // FROZEN prior-epoch markers (recorded turns whose ids are absent from the served
            // list) PRECEDE the remaining current tail; they are never dropped by a redo.
            let remaining_start = kept_end.unwrap_or(messages.len());
            let remaining_turns: Vec<Value> = messages[remaining_start..].iter().map(crate::opencode_message_turn_json).collect();
            let now = crate::rollback_record::now_ms();
            let previous = existing.clone();
            let mut record = existing.unwrap_or_else(|| RollbackRecord::empty(now));
            let served_ids: std::collections::HashSet<&str> = messages.iter().filter_map(|m| m["info"]["id"].as_str()).collect();
            let frozen: Vec<Value> = record.entries.drain(..).flat_map(|e| e.removed_turns)
                .filter(|t| t.get("turnId").or_else(|| t.get("id")).and_then(Value::as_str).map(|id| !served_ids.contains(id)).unwrap_or(true))
                .collect();
            let current_tail_non_empty = !remaining_turns.is_empty();
            record.entries = if !current_tail_non_empty && frozen.is_empty() { vec![] } else { vec![RollbackEntry {
                removed_turns: frozen.into_iter().chain(remaining_turns).collect(),
                prompt_text: remaining_prompt(&messages[remaining_start..]),
                at_ms: now,
            }]};
            record.last_op_at_ms = now;
            // can_redo gates ONLY on the current chain's remaining tail — frozen prior-epoch
            // markers are not restorable, so they must not keep redo alive (r3):
            record.set_can_redo(!record.redo_destroyed && current_tail_non_empty, now);
            if let Some(sink) = self.identity_sink.clone() {
                if let Err(e) = sink.record_rollback("opencode", &real_id, record.clone()).await {
                    tracing::warn!(error = %e, session = %real_id, "freshagent.opencode.rollback_pre_write_failed");
                    reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", LEDGER_WRITE_REFUSAL_COPY));
                    return; // provider history NEVER mutated on this path
                }
            }
            let result = if let Some(next_id) = &new_boundary_id {
                manager.revert(&real_id, next_id, &route).await
            } else {
                manager.unrevert(&real_id, &route).await
            };
            if let Err(err) = result {
                self.compensate_opencode_record(&real_id, previous.as_ref(), now).await;
                reply_sink(map_opencode_serve_error(&op, &err));
                return;
            }
            // POST-VERIFY (same r3 triad as the undo leg): pointer == the new boundary, or
            // ABSENT after a full unrevert.
            let verified = match manager.get_session(&real_id, &route).await {
                Ok(v) => v.get("revert").and_then(|r| r.get("messageID")).and_then(Value::as_str).map(str::to_string),
                Err(err) => {
                    // (c) READ failed — the mutation may have applied: KEEP the ledger (no
                    // compensating rewrite), report INTERNAL_ERROR; the next snapshot derives the
                    // prefix from provider rows, so pane + record reconverge automatically.
                    reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", &format!("redo issued but the post-rollback verification read failed: {err}")));
                    return;
                }
            };
            let verified_ok = match &new_boundary_id {
                Some(id) => verified.as_deref() == Some(id.as_str()),
                None => verified.is_none(),
            };
            if !verified_ok {
                // (b) read SUCCEEDED + pointer provably unmoved => compensate, then refuse:
                self.compensate_opencode_record(&real_id, previous.as_ref(), now).await;
                reply_sink(rollback_error_frame(&op, "INVALID_ROLLBACK_TARGET", "the serve accepted the redo but the rollback pointer did not move"));
                return;
            }
            let restored_turns: Vec<Value> = restored_slice.iter().map(crate::opencode_message_turn_json).collect();
            let restored_ids: Vec<String> = restored_slice.iter().filter_map(|m| m["info"]["id"].as_str().map(str::to_string)).collect();
            self.broadcast(&ServerMessage::FreshAgentEvent(changed_event_frame(&real_id)));
            let can_redo = record.can_redo();
            self.broadcast(&rollback_broadcast_frame(&op, &real_id, &restored_ids, can_redo));
            reply_sink(rollback_ack_frame(&op, &real_id, None, &restored_ids, can_redo, None));
            let _ = restored_turns;
        }
    }
}
```

with two shared helpers:

```rust
/// Revert/unrevert error mapping (correction item 4 + r1 remediation): an HTTP 404 /
/// unknown-route answer means the CLI predates the revert surface; only unknown
/// transport/other failures map to INTERNAL_ERROR.
fn map_opencode_serve_error(op: &RollbackRequest, err: &ServeError) -> ServerMessage {
    let msg = err.to_string();
    if msg.contains("404") || msg.to_ascii_lowercase().contains("unknown route") {
        rollback_error_frame(op, "UNSUPPORTED_CAPABILITY", OPENCODE_OLD_CLI_COPY)
    } else {
        rollback_error_frame(op, "INTERNAL_ERROR", &msg)
    }
}

/// Compensating write after a provider failure that followed a successful record pre-write:
/// restores the pre-op record (or an empty one) so the ledger never describes a rollback
/// the serve rejected. Warn-only — the refusal is answered regardless.
async fn compensate_opencode_record(&self, real_id: &str, previous: Option<&RollbackRecord>, now: i64) {
    if let Some(sink) = self.identity_sink.clone() {
        let restore = previous.cloned().unwrap_or_else(|| RollbackRecord::empty(now));
        if let Err(e) = sink.record_rollback("opencode", real_id, restore).await {
            tracing::warn!(error = %e, session = %real_id, "freshagent.opencode.rollback_compensate_failed");
        }
    }
}
```

Note for the implementer: `changed_event(real_id, reason)` at opencode_ws.rs:1713-1715 returns the inner Value; the existing emission idiom wraps it in the same `event_frame`/broadcast shape used at 1705-1715 — reuse that exact idiom (`changed_event_frame` above is shorthand for "the existing changed-event emission, reason `"opencode-rollback"`"); `session.updated` SSE stays dropped (events.rs:457-461) so this self-broadcast is the only invalidation. `handle_send` (opencode_ws.rs:626-627) gains, right where the turn flags reset (r2 lock discipline: the per-session mutex is ALREADY held at this point in the send flow — a send issued while a rollback held it simply WAITED on the mutex; `handle_send` NEVER acquires/consults `rollback_in_flight`, so no circular wait exists):

```rust
// Decision 5: any new submission permanently destroys redo (AWAITED before the prompt POST).
if let Some(real_id) = session.real_session_id.clone() {
    if let Some(err) = crate::rollback_record::destroy_redo_on_submit(&self.identity_sink, "opencode", &real_id, crate::rollback_record::now_ms()).await {
        tracing::warn!(error = %err, session = %real_id, "freshagent.opencode.redo_destroy_write_failed");
    }
}
```

`terminal.rs`: opencode arms dispatch both undo and redo to `fresh_opencode.handle_rollback(RollbackRequest::from_undo(m)|from_redo(m), conn_sink)` (detached spawn, fork-arm shape); the opencode cells drop out of the refusal surface.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-opencode && cargo test -p freshell-freshagent opencode_ws`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Deduplicate the redo branch's record-write/broadcast tail against the undo branch's (both legs share the pre-write → mutate → post-verify → broadcast sequence — factor a small `persist_record_and_warn` helper on the state if the closures stay readable). Verify the toTurn target validation refuses assistant ids pre-flight (INVALID_ROLLBACK_TARGET before any ledger write or mutation — the serve normalizes an assistant id to its parent user message and genuinely applies, so accepting one would compute the wrong removed slice and mis-fire the r3 post-verify compensation leg; icons appear only on user rows client-side, and the server refuses anything else). No behavior change.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the opencode adapter surface (all opencode_ws in-file tests incl. fork/send/compact), the opencode crate, and the WS dispatch matrix.

Run: `cargo test -p freshell-opencode && cargo test -p freshell-opencode --features real-transport && cargo test -p freshell-freshagent opencode && cargo test -p freshell-ws && cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-opencode/src/serve.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-freshagent/src/lib.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/freshagent_rollback_refusal.rs
git commit -m "feat(fresh-opencode): undo/redo conversation rollback via revert/unrevert (kata 1wxv task 3)"
```

---

### Task 4: Claude/kilroy undo/redo leg (fork-at-point emulation via the sidecar)

**Stage-2 binding amendments (from "## Load-bearing corrections", item 3):**
- SDK lane: ONLY `query({ resume, resumeSessionAt, forkSession: true, resumeDropsTurn: <guard uuid> })`. The standalone exported `forkSession()` fn is FORBIDDEN (it remaps every uuid). Vendored SDK version (r2 accuracy note): the sidecar's OWN lockfile pins `@anthropic-ai/claude-agent-sdk` 0.3.237 while the repo-level `node_modules` materializes 0.3.235 — the observed `query()` options (`resumeSessionAt`, `forkSession`, `resumeDropsTurn`) exist in BOTH; the bundled CLI is 2.1.235. Capability is statically advertised for claude/kilroy (the SDK init carries no capability bits) and runtime failure maps to an explicit refusal, never `INTERNAL_ERROR` (correction item 4).
- Redo validity contract: at undo, record `original_session_id` + `original_tip_uuid` in the rollback record (both fields exist in Task 1's `RollbackRecord`). Redo re-reads the chain-root original JSONL: it must still exist and its tip must still equal the recorded tip AND the LCP of current-session vs original must still resolve past the redo target; else refuse loudly with `REDO_UNAVAILABLE` (`REDO_REMOVED_HISTORY_COPY` = `Redo is no longer available — the original conversation's history changed since the undo.`). Compaction/snips can legitimately relink/remove uuids; this is the detection contract, not prevention.
- `in_turn` busy truth CLEAR-SET (LBC-10 falsified the original): clear on (a) `sdk.result` with ANY subtype — a result frame ends the turn (r2: the earlier "success-only" wording is void; `sdk.error` is NOT an edge), (b) `sdk.status:idle`, (c) sidecar EOF/death arm (`SIDECAR_EXITED` at claude.rs:1500-1553), (d) a completed `handle_interrupt` (claude.rs:706-734 — interrupts produce NO result frame). No other edges (no `sdk.error`, no `compacting`, no `assistant`, no status-kludge). The busy-clear test enumerates all four arms plus the fail-closed negatives; a missing arm = permanent BUSY_TURN wedge.
- Transcript line matching for the LCP/marker/removed-set computations compares `uuid` + `message` content ONLY and ignores `sessionId`/`entrypoint`/`gitBranch`/`promptId` (rewritten on copies) and skips fork header/tail line kinds (`mode`, `atis-latch`, `queue-operation`, `last-prompt`).
- Claude FIRST-TURN rollback is LEGAL (r2; replaces the earlier `INVALID_ROLLBACK_TARGET` first-turn refusal — `CLAUDE_FIRST_TURN_REFUSAL` is removed): `resolve_resume_point` yielding `resume_at_uuid: None` means "before the first message". The handler emits the pending-cancel frames, kills the sidecar, and spawns a FRESH conversation (create with NO resume); the discarded durable session is recorded as the record's `original_session_id` with `original_tip_uuid` = its raw-chain tip; adoption rides the existing sdk.session.init leg (cli_index insert + awaited binding + rollback-row re-key). `canRedo` from the record = the original tip strictly beyond the live chain tip (live tip = none here); redo = re-fork the original at THE LAST RAW-CHAIN UUID OF THE RESTORED FIRST STEP'S GROUP — its assistant tail (r3: `resumeSessionAt` keeps through-AND-including the named uuid, so restoring the `u1`/`a1` step resumes at `a1`, never `u1`; "first user message uuid" is the group anchor, not the resume point) — fork-at-point, the proved-full-retention path — and adopt. Rollback to an empty conversation is thus uniformly legal across codex/opencode/claude.

**Files:**
- Modify: `crates/freshell-claude-sidecar/index.mjs:236-258` (pass `resumeSessionAt` + `forkSession` into the SDK `query` options; header protocol doc updated)
- Modify: `crates/freshell-freshagent/src/claude_snapshot.rs` (`parse_transcript_turns` surfaces real message uuids as turn ids — replacing the synthetic `{thread_id}:{ordinal}` ids when a `uuid` key is present; new pure `resolve_resume_point`; `build_claude_snapshot_json` unchanged in shape)
- Modify: `crates/freshell-freshagent/src/claude.rs` (`ClaudeSession` gains `in_turn: Arc<AtomicBool>` + the per-session async `turn_lock: Arc<tokio::sync::Mutex<()>>`; `handle_send` sets `in_turn` UNDER `turn_lock` BEFORE the sidecar write; the stdout consumer/interrupt paths clear it on EXACTLY the four contract edges — `sdk.result` (any subtype), `sdk.status:idle`, sidecar EOF/`SIDECAR_EXITED`, completed `handle_interrupt` — `sdk.error` is NOT an edge; `handle_rollback` (incl. the first-turn fresh-conversation leg and the epoch re-root); pending-cancel emission helper; `handle_send` destroys redo)
- Modify: `crates/freshell-ws/src/terminal.rs` (claude undo+redo arms route to `handle_rollback` — covers freshclaude and kilroy; amplifier x op cells stay refused forever)
- Modify: `crates/freshell-ws/tests/freshagent_rollback_refusal.rs` (claude freshclaude/kilroy undo+redo cases removed — real dispatch; amplifier cells added as the permanent ones)
- Test: `crates/freshell-freshagent/src/claude_snapshot.rs` (in-file `#[cfg(test)]`), `crates/freshell-ws/tests/freshagent_claude_rollback.rs` (new integration file, harness of `freshagent_claude_kill_interrupt.rs`)

**Interfaces:**
- Consumes: sidecar stdin discipline (`crates/freshell-claude-sidecar/index.mjs:225-270`), the adoption path (`sdk.session.init` consumer, cli_index insert, AWAITED binding write, `claude.rs:1440-1492`), lease claim + bind idiom (create-resume, claude.rs:382-431 + 515-524, 542-565), pending fold (`fold_pending_frame` claude.rs:1565+; cancelled normalization at :1766-1772), `spawn_sidecar` (:1887-1923), `locate_transcript`/`claude_home_candidates` (`claude_snapshot.rs`), Task 1's `RollbackRequest`/frames/`destroy_redo_on_submit`.
- Produces:
  - Sidecar `create` accepts optional `resumeSessionAt: string`, `forkSession: boolean`, and `resumeDropsTurn: string` (SDK options passthrough).
  - `pub(crate) enum ResumeTarget { Step, ToTurn(String) }` and `pub(crate) struct ResumePoint { pub resume_at_uuid: Option<String>, pub removed_turns: Vec<Value>, pub prompt_text: String }` with
    `pub(crate) fn resolve_resume_point(transcript: &str, thread_id: &str, target: ResumeTarget) -> Result<ResumePoint, ResumeResolveError>` in `claude_snapshot.rs`, where `ResumeResolveError::{Empty, TargetNotFound}` (r2: NO `FirstTurn` variant — `resume_at_uuid: None` is a legal resolution):
    - parse the JSONL preserving per-line `uuid` + `parentUuid`;
    - ordering rule (flash-corrected to raw-chain everywhere; the display-predecessor variant is VOID per correction item 3): the chain is walked over the RAW parentUuid links of ALL transcript lines — including lines the display parser filters out (user-meta/sidechain/skipped); display filtering applies ONLY to the removed-turns PROJECTION, never to chain position;
    - a STEP is one user-anchor line + every raw line until the next user anchor, in raw-chain order;
    - Step: the last step's first message uuid; toTurn: the addressed turn's first message uuid (must exist);
    - `resume_at_uuid` = the RAW parentUuid of that first-to-remove line (walk the `parentUuid` chain); `None` when the first-to-remove line is the very first transcript message = "BEFORE THE FIRST MESSAGE" (r2: LEGAL — the caller takes the fresh-conversation leg, never a refusal);
    - `removed_turns` = the display-turn projections (`parse_transcript_turns`) of the removed slice; `prompt_text` = plain text of the first removed user turn.
  - Pure chain helpers in `claude_snapshot.rs`: `pub(crate) fn raw_chain_tip(transcript: &str) -> Option<String>` (last uuid of the raw parentUuid chain) and `pub(crate) fn raw_lcp_end(current: &str, original: &str) -> Option<String>` (uuid ending the common raw-chain prefix).
  - Turn ids: `parse_transcript_turns` stamps `id`/`turnId` from the line's `uuid` when present, falling back to the existing synthetic `{thread_id}:{ordinal}`; `item` ids (`{turn_id}-i{j}`) follow the new turn id.
  - `FreshClaudeState::handle_rollback(&self, op: RollbackRequest, reply_sink: FrameSink)`.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-freshagent/src/claude_snapshot.rs` — append to its test module:

```rust
// ── kata 1wxv Task 4: resume-point math + real-uuid turn ids ────────────

fn uuid_transcript() -> String {
    // user/assistant alternation, uuid + parentUuid chained:
    [
        json!({"type":"user","uuid":"u1","parentUuid":null,"timestamp":"t1","message":{"role":"user","content":[{"type":"text","text":"prompt one"}]}}),
        json!({"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"t2","message":{"role":"assistant","content":[{"type":"text","text":"answer one"}]}}),
        json!({"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"t3","message":{"role":"user","content":[{"type":"text","text":"prompt two"}]}}),
        json!({"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"t4","message":{"role":"assistant","content":[{"type":"text","text":"answer two"}]}}),
    ].iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n")
}

#[test]
fn turns_carry_real_message_uuids_when_present() {
    let turns = parse_transcript_turns("thread-x", &uuid_transcript());
    let ids: Vec<&str> = turns.iter().filter_map(|t| t.get("turnId").and_then(Value::as_str)).collect();
    assert!(ids.contains(&"u1") && ids.contains(&"a1") && ids.contains(&"u2") && ids.contains(&"a2"),
        "turn ids are the transcript uuids, not synthetic thread:ordinal ids: {ids:?}");
}

#[test]
fn resolve_resume_point_step_targets_the_last_user_step() {
    let point = resolve_resume_point(&uuid_transcript(), "thread-x", ResumeTarget::Step).expect("resolves");
    assert_eq!(point.resume_at_uuid.as_deref(), Some("a1"), "keep everything before prompt two's group");
    assert_eq!(point.prompt_text, "prompt two");
    let removed_ids: Vec<&str> = point.removed_turns.iter().filter_map(|t| t.get("turnId").and_then(Value::as_str)).collect();
    assert_eq!(removed_ids, vec!["u2", "a2"]);
}

#[test]
fn resolve_resume_point_at_the_first_message_resolves_before_the_first_message() {
    // r2: RESOLVABLE and legal — resume_at_uuid None means "before the first message";
    // the whole transcript becomes the removed slice and the handler takes the
    // fresh-conversation leg (no refusal exists).
    let point = resolve_resume_point(&uuid_transcript(), "thread-x", ResumeTarget::ToTurn("u1".into())).expect("resolves");
    assert_eq!(point.resume_at_uuid, None, "before the first message");
    assert_eq!(point.prompt_text, "prompt one");
    let removed_ids: Vec<&str> = point.removed_turns.iter().filter_map(|t| t.get("turnId").and_then(Value::as_str)).collect();
    assert_eq!(removed_ids, vec!["u1", "a1", "u2", "a2"], "the entire transcript is the removed slice");
}

#[test]
fn resolve_resume_point_step_on_a_single_step_resolves_before_the_first_message() {
    let one_step = uuid_transcript().lines().take(2).collect::<Vec<_>>().join("\n"); // u1/a1 only
    let point = resolve_resume_point(&one_step, "thread-x", ResumeTarget::Step).expect("resolves");
    assert_eq!(point.resume_at_uuid, None, "step on a one-turn history empties the conversation — legal per r2");
    assert_eq!(point.prompt_text, "prompt one");
}

#[test]
fn resolve_resume_point_to_turn_middle_keeps_prefix() {
    let point = resolve_resume_point(&uuid_transcript(), "thread-x", ResumeTarget::ToTurn("u2".into())).expect("resolves");
    assert_eq!(point.resume_at_uuid.as_deref(), Some("a1"));
    assert_eq!(point.removed_turns.len(), 2);
}

#[test]
fn resolve_resume_point_unknown_target_is_not_found() {
    assert!(resolve_resume_point(&uuid_transcript(), "thread-x", ResumeTarget::ToTurn("nope".into())).is_err());
}
```

`crates/freshell-freshagent/src/claude.rs` — append to its test module (registration idiom mirrors the file's existing `handle_kill` unit tests):

```rust
#[tokio::test]
async fn in_turn_clears_on_exactly_the_four_contract_edges_fail_closed_otherwise() {
    // Enumerate ALL FOUR clear edges plus the fail-closed negatives, driving the stdout
    // consumer / interrupt path with this file's existing fake-sidecar rig:
    // (a) sdk.result clears with ANY subtype (r2: a result frame ends the turn);
    // (b) sdk.status with status == "idle" clears;
    // (c) sidecar EOF/death (the SIDECAR_EXITED arm, claude.rs:1500-1553) clears;
    // (d) a completed handle_interrupt (claude.rs:706-734) clears;
    // plus: an interrupt NEVER produces a result frame on the wire (assert none observed),
    // and the NON-EDGES must NOT clear — sdk.error, sdk.status=compacting, and
    // sdk.assistant frames leave in_turn TRUE (fail-closed).
    // A missing arm wedges BUSY_TURN refusals forever — this test fails if any arm is
    // dropped or any additional clearing edge is added.
}

#[tokio::test]
async fn handle_rollback_mid_turn_is_busy_and_never_touches_the_sidecar() {
    // Register a live session however this file's existing tests do (fake stdin writer);
    // set session.in_turn = true; call handle_rollback; assert exactly one sink frame
    // BUSY_TURN with ROLLBACK_BUSY_MESSAGE, rollback:true, requestId echoed, and that
    // NO line was written to the session's stdin and NO sidecar was spawned/killed.
}

#[tokio::test]
async fn handle_rollback_redo_without_a_record_is_redo_unavailable() {
    // Live session, no rollback record in the fake sink -> REDO_UNAVAILABLE + REDO_EMPTY_MESSAGE.
}

#[tokio::test]
async fn handle_rollback_record_write_failure_refuses_before_any_sidecar_churn() {
    // Durable-BEFORE-mutation: fake sink in fail-writes mode; live two-turn session;
    // handle_rollback step -> exactly one frame INTERNAL_ERROR + LEDGER_WRITE_REFUSAL_COPY,
    // rollback:true; assert NO stdin write, NO sidecar kill/spawn (provider never mutated).
}

#[tokio::test]
async fn handle_rollback_redo_with_a_moved_original_tip_is_redo_unavailable() {
    // Seed a record with original_session_id + original_tip_uuid; rewrite the original's
    // JSONL so its raw-chain tip no longer equals the recorded tip (or so the current
    // chain no longer prefixes it); the redo leg must refuse with REDO_UNAVAILABLE +
    // REDO_REMOVED_HISTORY_COPY and must NOT spawn/fork anything.
}

#[tokio::test]
async fn emit_pending_cancellations_maps_every_parked_entry() {
    // Seed ClaudePending with one permission + one question entry; call the helper;
    // assert broadcast frames freshAgent.permission.cancelled{requestId} and
    // freshAgent.question.cancelled{requestId} (the fold shape at claude.rs:1766-1772),
    // and that the pending map is empty afterwards (never silently resolved — decision 6).
}

#[tokio::test]
async fn handle_rollback_after_a_resend_re_roots_the_chain_and_redo_restores_the_new_epoch() {
    // r3 epoch rule on this lane (undo→send→undo↔redo): seed live session S' (a fork of
    // original O whose record carries original_session_id=O with redo_destroyed=true) and
    // drive one more undo; assert the NEW record's original_session_id == S' (re-rooted to
    // the CURRENT durable id — O's chain is never reused for redo: O's redo stays
    // permanently dead) and original_tip_uuid == S' chain tip; assert the marker bucket is
    // the UNION — the old epoch's removed turns PERSIST in ledger `entries` ahead of the
    // newest epoch's (decision 6; r3 — only the redo-capable chain state re-roots,
    // markers never drop); and assert a following redo re-forks from S' (restores EXACTLY
    // the newest epoch's removed tail — the frozen prior-epoch markers are not restorable).
}

#[tokio::test]
async fn concurrent_send_plus_undo_serializes_on_the_turn_lock_without_deadlock() {
    // r2 lock discipline on this lane: drive a SLOW rollback (fake-sidecar create deferred)
    // with handle_rollback, fire handle_send mid-flight, and bound the join with
    // tokio::time::timeout (no deadlock); assert the send's sidecar write lands strictly
    // AFTER the rollback's kill+spawn+adoption completes (the send waited on the session
    // turn lock — handle_send never touches rollback_in_flight) and the send's
    // destroy_redo_on_submit ran against the post-rollback record (send waits, rollback
    // wins, then destroys).
}
```

`crates/freshell-ws/tests/freshagent_claude_rollback.rs` — new integration test (real axum server + inline scripted fake sidecar, EXACTLY the harness conventions of `freshagent_claude_kill_interrupt.rs`: `CLAUDE_ENV_LOCK`, `spawn_server()`, `FRESHELL_CLAUDE_SIDECAR`/`FRESHELL_CLAUDE_NODE` env overrides, tempfile `HOME`, newline-JSON inline node script):

```rust
//! Kata 1wxv Task 4: end-to-end claude rollback dispatch through the REAL WS
//! pipeline against a scripted fake sidecar. The inline fake implements the
//! production sidecar protocol plus the fork-at-point additions: on create with
//! forkSession:true it mints a NEW cliSessionId and writes the transcript PREFIX
//! (up to and including resumeSessionAt) for the child under the fake CLAUDE_HOME;
//! every create line is logged to $FAKE_SIDECAR_LOG for assertion.

#[tokio::test]
async fn claude_undo_recreates_the_sidecar_with_resume_session_at_and_rekeys_the_pane() {
    // boot with env: FRESHELL_CLAUDE_SIDECAR=<inline .mjs path>, FRESHELL_CLAUDE_NODE="node",
    // CLAUDE_CONFIG_DIR=<tmp>, HOME=<tmp home>; hello; freshAgent.create (freshclaude);
    // drive two sends so the fake transcript has u1/a1/u2/a2 (the fake assigns uuids);
    // freshAgent.undo {mode: step} ->
    let frame: Value = next_frame_matching(&mut ws, |f| {
        f["type"] == "freshAgent.event" && f["event"]["type"] == "freshAgent.rolledBack"
    }).await;
    assert_eq!(frame["event"]["removedPromptText"], json!("second prompt"));
    let new_id = frame["event"]["newSessionId"].as_str().expect("claude ack carries the adopted id");
    assert_ne!(new_id, original_cli_id, "forkSession mints a fresh durable id");
    // the materialized broadcast re-keyed the session (existing repoint idiom):
    let materialized = frames_of_type(&captured, "freshAgent.session.materialized");
    assert_eq!(materialized.last().unwrap()["sessionId"], json!(new_id));
    // the fake sidecar saw the fork-at-point create:
    let creates = read_jsonl(&log_path);
    let fork_create = creates.iter().find(|l| l["msg"]["forkSession"] == json!(true)).expect("fork create observed");
    assert_eq!(fork_create["msg"]["resume"], json!(original_cli_id));
    assert_eq!(fork_create["msg"]["resumeSessionAt"], json!("a1"), "keep prefix through a1");
    // REST snapshot by the NEW id is the prefix:
    let snapshot = http_get_json(&format!("{url}/api/fresh-agent/threads/freshclaude/claude/{new_id}?cwd=...")).await;
    let turn_texts = snapshot["turns"].as_array().expect("turns");
    assert_eq!(turn_texts.len(), 2, "prefix only: u1+a1");
    // durable record: original_session_id + original_tip_uuid recorded for the redo contract:
    let record_path = tmp_home.join(".freshell/pane-ledger/rollback/claude").read_dir().unwrap().next().unwrap().path();
    let record: Value = serde_json::from_str(&std::fs::read_to_string(record_path).unwrap()).unwrap();
    assert_eq!(record["originalSessionId"], json!(original_cli_id));
    assert!(record["originalTipUuid"].is_string(), "undo stamps the original's raw-chain tip uuid");
    assert_eq!(record["canRedo"], json!(true));
    // no turn.complete anywhere in the capture (no chime):
    assert!(all_frames.iter().all(|f| f["event"]["type"] != json!("freshAgent.turn.complete")));
}

#[tokio::test]
async fn claude_redo_reforks_from_the_original_at_a_later_point() {
    // Same rig; after the undo above, freshAgent.redo {mode: step} ->
    // assert the observed create has resume == ORIGINAL id (chain root), forkSession == true,
    // resumeSessionAt == "a2" (the last uuid of the restored step), and the new snapshot
    // carries all four turns.
}

#[tokio::test]
async fn claude_undo_of_the_only_turn_empties_the_conversation_via_a_fresh_create() {
    // r2: first-turn rollback is LEGAL. One-step history (u1/a1); freshAgent.undo {step} ->
    // exactly ONE ack freshAgent.rolledBack (removedPromptText == the only prompt, canRedo
    // == true); the sidecar log shows ONE create WITHOUT resume/fork keys (a FRESH
    // conversation — the empty fresh transcript IS the rollback target); the materialized
    // broadcast re-keys the pane to a NEW durable id; the rollback record carries
    // originalSessionId == the discarded id and originalTipUuid == the discarded chain's
    // tip (a1). A following freshAgent.redo re-forks the ORIGINAL at the LAST raw-chain
    // uuid of the restored u1/a1 step's group — its assistant tail (r3 boundary fix —
    // resumeSessionAt keeps through-AND-including the named uuid): create with
    // forkSession:true, resumeSessionId == original, resumeSessionAt == a1 (NOT u1 — that
    // would restore only the bare prompt and make undo/redo non-invertible), and adopts
    // the re-keyed id again.
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent claude_snapshot::tests && cargo test -p freshell-freshagent claude::tests::handle_rollback && cargo test -p freshell-ws --test freshagent_claude_rollback`

Expected: FAIL because `resolve_resume_point` and uuid turn ids don't exist in `claude_snapshot.rs`, `in_turn`/`handle_rollback` don't exist in `claude.rs`, the sidecar options don't pass `resumeSessionAt`/`forkSession`, and the claude arms still refuse at dispatch.

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-claude-sidecar/index.mjs` (:236-247 options block):

```js
        cwd: req.cwd || undefined,
        resume: req.resumeSessionId,
        resumeSessionAt: req.resumeSessionAt || undefined,
        forkSession: req.forkSession === true || undefined,
        resumeDropsTurn: req.resumeDropsTurn || undefined,
        model: req.model,
```

(Also document all three keys — `resumeSessionAt`, `forkSession`, `resumeDropsTurn` — in the header protocol comment :9-16.)

`crates/freshell-freshagent/src/claude_snapshot.rs`:
- In the turn builder loop (:410-474): replace `let turn_id = format!("{thread_id}:{ordinal}");` with uuid-first:

```rust
        let ordinal = turns.len();
        let line_uuid = obj.get("uuid").and_then(Value::as_str).filter(|s| !s.is_empty());
        // kata 1wxv: real message uuids are the rollback-addressable turn identity;
        // the synthetic {thread}:{ordinal} stays as the fallback for uuid-less lines.
        let turn_id = line_uuid.map(str::to_string).unwrap_or_else(|| format!("{thread_id}:{ordinal}"));
```

- Append `ResumeTarget`/`ResumePoint`/`ResumeResolveError`/`resolve_resume_point` per Interfaces, plus pure chain helpers `pub(crate) fn raw_chain_tip(transcript: &str) -> Option<String>` (last uuid of the raw parentUuid chain) and `pub(crate) fn raw_lcp_end(current: &str, original: &str) -> Option<String>` (uuid ending the common raw-chain prefix; redo validity requires it == current's tip). Resolver ordering rule (flash-corrected to the raw-chain rule everywhere — the display-predecessor variant is VOID per correction item 3): parse the transcript preserving per-line `uuid`/`parentUuid` and walk the RAW parentUuid chain over ALL transcript lines — every line carrying uuid+parentUuid participates in chain position, including lines the display parser filters out (user-meta/sidechain/skipped); display filtering applies ONLY to the `removed_turns` PROJECTION (via `parse_transcript_turns`), never to chain position. Steps = split at user-anchor lines in raw-chain order; Step = last step, toTurn = step containing/starting at the addressed uuid (an addressed ASSISTANT uuid maps to its owning user step — first user anchor at-or-before it along the chain); `resume_at_uuid` = the step first line's RAW parentUuid (None when the step is the head = "before the first message" — a LEGAL resolution per r2: the caller takes the fresh-conversation leg, never a refusal); removed = steps[t..] projected; prompt = plain text of the step's first user line. Match the test expectations exactly.

`crates/freshell-freshagent/src/claude.rs`:
1. `ClaudeSession` gains `in_turn: Arc<std::sync::atomic::AtomicBool>` (new-session init false) and `turn_lock: Arc<tokio::sync::Mutex<()>>` (the per-session async turn lock from the r2 serialization discipline). `handle_send` takes `turn_lock` and sets `in_turn` true UNDER it after resolve but BEFORE the `write_line` to the sidecar succeeds (:764-768) — the check-then-set window against `handle_rollback`'s busy check is closed; `handle_send` NEVER acquires/consults `rollback_in_flight` — while a rollback holds the turn lock, the send waits on the lock, then proceeds and destroys redo. The clear-set is EXACTLY four edges and no others (fail-closed otherwise — a missing arm wedges `BUSY_TURN` refusals forever): (a) `sdk.result` with ANY subtype — a result frame ends the turn (r2: the earlier "success-only" wording is void), (b) `sdk.status` with `status == "idle"`, (c) sidecar EOF/death (the `SIDECAR_EXITED` arm at claude.rs:1500-1553), (d) a completed `handle_interrupt` (claude.rs:706-734 — interrupts produce NO result frame at all). No `sdk.error` edge, no `compacting`/`assistant` edges, no status-kludge.
2. New helper:

```rust
/// Decision 6: pending cards inside undone turns are CANCELLED, never silently resolved.
/// Emits the exact `freshAgent.permission.cancelled`/`freshAgent.question.cancelled`
/// frames the fold at claude.rs:1766-1772 consumes, one per parked entry, then clears
/// the pending map. Invoked BEFORE the old sidecar is torn down.
async fn emit_pending_cancellations(&self, map_key: &str, session_id: &str, session_type: &str)
```

3. `handle_rollback` (shape — every leg loud, never silence):

```rust
pub async fn handle_rollback(&self, op: RollbackRequest, reply_sink: FrameSink) {
    use crate::rollback_record::*;
    // resolve + single-flight + serializing turn lock (r2 discipline):
    let Some(map_key) = self.resolve_session_key(&op.session_id).await else {
        reply_sink(rollback_error_frame(&op, "INVALID_SESSION_ID", "claude session not found"));
        return;
    };
    if op.mode == RollbackModeReq::ToTurn && op.turn_id.is_none() { reply_sink(rollback_error_frame(&op, "INVALID_ROLLBACK_TARGET", "toTurn requires a turnId")); return; }
    let (durable_id, in_turn, turn_lock, session_type) = {
        let guard = self.sessions.lock().await;
        match guard.get(&map_key) {
            Some(s) => (s.cli_session_id.clone().unwrap_or_else(|| map_key.clone()), s.in_turn.clone(), s.turn_lock.clone(), session_type_str(op.session_type)),
            None => { reply_sink(rollback_error_frame(&op, "INVALID_SESSION_ID", "claude session not found")); return; }
        }
    };
    // Lock ORDER (r2): rollback_in_flight (rollback-vs-rollback only) FIRST, then the
    // per-session turn lock — held across the WHOLE handler (busy gate, transcript reads,
    // record pre-write, pending-cancel, sidecar kill + spawn, adoption, reply).
    // handle_send NEVER acquires/consults rollback_in_flight: it waits on this same turn
    // lock while a live rollback holds it, then proceeds and destroys redo — no circular
    // wait exists.
    let Some(_guard) = self.rollback_in_flight.try_acquire(&durable_id) else {
        reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", &format!("rollback already in progress for {durable_id}")));
        return;
    };
    let _turn = turn_lock.lock().await; // held for the REST of this handler
    // in_turn is set by handle_send UNDER this same lock BEFORE the sidecar write, closing
    // the check-then-set window: observed false here means no send is in flight.
    if in_turn.load(std::sync::atomic::Ordering::SeqCst) {
        reply_sink(rollback_error_frame(&op, "BUSY_TURN", ROLLBACK_BUSY_MESSAGE));
        return;
    }

    // Load any existing record (redo source + chain root) BEFORE choosing the fork parameters:
    let now = crate::rollback_record::now_ms();
    let existing = self.identity_sink.as_ref().and_then(|s| s.load_rollback("claude", &durable_id));

    // resume_at_uuid: Option<String> — None on the claude "before the first message" leg
    // (r2 first-turn rollback: a FRESH conversation is created with NO resume keys).
    let (resume_from, resume_at_uuid, removed_turns, prompt_text, chain_root, original_tip_uuid, can_redo_after) = match op.direction {
        RollbackDirection::Undo => {
            let path = match crate::claude_snapshot::locate_transcript(&durable_id) { Some(p) => p, None => { reply_sink(rollback_error_frame(&op, "NOTHING_TO_UNDO", UNDO_EMPTY_MESSAGE)); return; } };
            let text = match std::fs::read_to_string(&path) { Ok(t) => t, Err(e) => { reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", &e.to_string())); return; } };
            let target = match op.mode { RollbackModeReq::Step => crate::claude_snapshot::ResumeTarget::Step, RollbackModeReq::ToTurn => crate::claude_snapshot::ResumeTarget::ToTurn(op.turn_id.clone().expect("validated")) };
            let point = match crate::claude_snapshot::resolve_resume_point(&text, &durable_id, target) {
                Ok(p) => p, // resume_at_uuid None = "before the first message" — LEGAL (r2): the fresh-conversation spawn leg below handles it
                Err(crate::claude_snapshot::ResumeResolveError::Empty) => { reply_sink(rollback_error_frame(&op, "NOTHING_TO_UNDO", UNDO_EMPTY_MESSAGE)); return; }
                Err(_) => { reply_sink(rollback_error_frame(&op, "INVALID_ROLLBACK_TARGET", &format!("turn {:?} is not in this conversation", op.turn_id))); return; }
            };
            // Epoch rule (r2): an undo landing while redo_destroyed is set re-roots the chain
            // to the CURRENT durable id — the retained old original describes a branch a resend
            // already permanently replaced; the fresh record written below carries no old-epoch
            // state, and redo can never re-fork over a stale root.
            let chain_root = existing.as_ref().filter(|r| !r.redo_destroyed).and_then(|r| r.original_session_id.clone()).unwrap_or_else(|| durable_id.clone());
            // Tip anchor at UNDO time = the last raw-chain uuid of the CHAIN-ROOT transcript
            // (the root retains the full history; at the first undo the current file IS the root):
            let root_text = if chain_root == durable_id {
                text.clone()
            } else {
                match crate::claude_snapshot::locate_transcript(&chain_root).and_then(|p| std::fs::read_to_string(p).ok()) {
                    Some(t) => t,
                    None => { reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", "chain-root transcript unreadable")); return; }
                }
            };
            let tip = crate::claude_snapshot::raw_chain_tip(&root_text);
            // Removed content provably exists in the original beyond the resume point.
            // can_redo after the undo: the original's tip is strictly beyond the post-op
            // live tip (that is the resume point; on the r2 first-turn leg the fresh
            // conversation's tip is NONE — strictly beyond holds whenever a tip exists):
            (durable_id.clone(), point.resume_at_uuid, point.removed_turns, point.prompt_text, chain_root, tip, true)
        }
        RollbackDirection::Redo => {
            let Some(record) = existing.clone() else { reply_sink(rollback_error_frame(&op, "REDO_UNAVAILABLE", REDO_EMPTY_MESSAGE)); return; };
            if record.redo_destroyed { reply_sink(rollback_error_frame(&op, "REDO_UNAVAILABLE", REDO_DESTROYED_MESSAGE)); return; }
            let Some(original) = record.original_session_id.clone() else { reply_sink(rollback_error_frame(&op, "REDO_UNAVAILABLE", REDO_EMPTY_MESSAGE)); return; };
            // One step forward: the kept prefix grows by exactly one user step. The redo
            // target inside the ORIGINAL is the first user message strictly AFTER the
            // current tip-or the addressed toTurn uuid's group end (uniform t_pos math,
            // same as opencode Task 3 but over uuids):
            let original_path = match crate::claude_snapshot::locate_transcript(&original) { Some(p) => p, None => { reply_sink(rollback_error_frame(&op, "REDO_UNAVAILABLE", REDO_REMOVED_HISTORY_COPY)); return; } };
            let original_text = match std::fs::read_to_string(&original_path) { Ok(t) => t, Err(e) => { reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", &e.to_string())); return; } };
            let current_path = match crate::claude_snapshot::locate_transcript(&durable_id) { Some(p) => p, None => { reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", "current transcript missing")); return; } };
            let current_text = std::fs::read_to_string(&current_path).unwrap_or_default();
            // Redo validity contract (wire design): the original must BE the history the undo
            // observed — its raw-chain tip equals record.original_tip_uuid — AND the LCP of
            // current-session vs original resolves PAST the current tip (the current raw
            // chain is still a strict prefix of the original) with the redo target inside
            // the original's tail beyond it. Any miss => REDO_UNAVAILABLE +
            // REDO_REMOVED_HISTORY_COPY (compaction/snips/other-device history edits are
            // detected, never silently re-forked over).
            let original_tip = crate::claude_snapshot::raw_chain_tip(&original_text);
            if original_tip != record.original_tip_uuid {
                reply_sink(rollback_error_frame(&op, "REDO_UNAVAILABLE", REDO_REMOVED_HISTORY_COPY)); return;
            }
            if crate::claude_snapshot::raw_lcp_end(&current_text, &original_text) != crate::claude_snapshot::raw_chain_tip(&current_text) {
                reply_sink(rollback_error_frame(&op, "REDO_UNAVAILABLE", REDO_REMOVED_HISTORY_COPY)); return;
            }
            // t_pos: toTurn => position of T in the ORIGINAL's raw-chain uuid list;
            // Step => position of current tip's last uuid in that list (the LCP end).
            // kept end = the uuid ENDING the addressed group (last uuid before the next user uuid).
            // Empty live chain (r2 first-turn case): the current transcript has no raw-chain
            // lines, its tip is None, and the LCP resolves vacuously; redo_resume_target then
            // answers THE LAST UUID OF THE ORIGINAL'S FIRST STEP GROUP — its assistant tail
            // (r3 boundary fix: re-fork at `a1` for the u1/a1 step — resumeSessionAt keeps
            // through-AND-including the named uuid — NEVER at the first user-anchor uuid
            // itself, which would restore only the bare prompt).
            let resume_at = match redo_resume_target(&original_text, &current_text, &op) {
                Ok(Some(uuid)) => uuid,
                Ok(None) => { reply_sink(rollback_error_frame(&op, "REDO_UNAVAILABLE", REDO_EMPTY_MESSAGE)); return; }
                Err(msg) => { reply_sink(rollback_error_frame(&op, "INVALID_ROLLBACK_TARGET", &msg)); return; }
            };
            // The "removed" payload for a redo ack = the restored slice (original turns from
            // just-after-LCP through resume_at) — projection via parse_transcript_turns prefix diff.
            let restored = restored_slice_turns(&original_text, &current_text, &resume_at);
            // can_redo after this redo = the original's tip lies strictly beyond resume_at:
            let can_redo_after_redo = original_tip.as_deref() != Some(resume_at.as_str());
            (original, Some(resume_at), restored.turns, restored.prompt_text, record.original_session_id.clone(), record.original_tip_uuid.clone(), can_redo_after_redo)
        }
    };

    // Durable record FIRST (durable-BEFORE-mutation): computed from the pre-mutation reads,
    // keyed by the CURRENT durable id, AWAITED before anything is torn down. The
    // sdk.session.init ADOPTION leg later re-keys the row old->new inside its existing
    // AWAITED write batch (supersedes: old durable id), so there is exactly one
    // rollback-record-specific write and it always precedes the mutation. Pre-write failure
    // REFUSES the rollback — no pending-cancel storm, no sidecar churn, no fork.
    // r3: `entries` carries the UNION marker bucket on this lane too (no longer empty) —
    // prior markers always survive; this op's slice is spliced in conversation position:
    let mut record = existing.clone().unwrap_or_else(|| RollbackRecord::empty(now));
    match op.direction {
        RollbackDirection::Undo => {
            // Epoch rule (r3): an undo landing while redo_destroyed clears the destroyed bit
            // (the record's redo state now describes the NEW chain — the prior chain's redo
            // stays permanently dead) and NEVER clears entries. Conversation-position splice:
            // a NEW epoch (redo_destroyed was set, or the chain root re-roots away from the
            // prior record's original) FROZES every prior entry (they stay first, unchanged);
            // otherwise the prior entries are the CURRENT epoch's and the new slice is
            // inserted ahead of them (later undos move the boundary backward).
            let new_epoch: bool = record.redo_destroyed
                || (existing.as_ref().map(|r| r.original_session_id.is_some()).unwrap_or(false)
                    && existing.as_ref().and_then(|r| r.original_session_id.clone()).as_deref() != Some(chain_root.as_str()));
            if record.redo_destroyed { record.redo_destroyed = false; /* prior chain's redo stays dead */ }
            let prior: Vec<RollbackEntry> = record.entries.drain(..).collect();
            let (frozen, current): (Vec<RollbackEntry>, Vec<RollbackEntry>) =
                if new_epoch { (prior, vec![]) } else { (vec![], prior) };
            record.entries = frozen.into_iter()
                .chain(std::iter::once(RollbackEntry { removed_turns: removed_turns.clone(), prompt_text: prompt_text.clone(), at_ms: now }))
                .chain(current).collect();
        }
        RollbackDirection::Redo => {
            // The restored turns leave the CURRENT-epoch marker portion (they are live
            // again); frozen prior-epoch markers can never match a restorable id (the redo
            // contract's LCP/tip validation can only restore from the current chain root).
            let restored_id_set: std::collections::HashSet<&str> = removed_turns.iter().filter_map(|t| t.get("turnId").or_else(|| t.get("id")).and_then(Value::as_str)).collect();
            record.entries.retain_mut(|e| { e.removed_turns.retain(|t| !t.get("turnId").or_else(|| t.get("id")).and_then(Value::as_str).map(|id| restored_id_set.contains(id)).unwrap_or(false)); !e.removed_turns.is_empty() });
        }
    }
    record.original_session_id = Some(chain_root.clone());
    record.original_tip_uuid = original_tip_uuid.clone();
    record.last_op_at_ms = now;
    record.set_can_redo(can_redo_after, now);
    if let Some(sink) = self.identity_sink.clone() {
        if let Err(e) = sink.record_rollback("claude", &durable_id, record.clone()).await {
            tracing::warn!(error = %e, session = %durable_id, "freshagent.claude.rollback_pre_write_failed");
            reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", LEDGER_WRITE_REFUSAL_COPY));
            return;
        }
    }

    // Cancel pending cards BEFORE teardown (decision 6) — both spawn legs:
    self.emit_pending_cancellations(&map_key, &op.session_id, &session_type).await;

    // Lease discipline: claim the OLD durable id exactly like the create-resume path
    // (claude.rs:382-431) so a concurrent attach cannot bind the pre-rollback id mid-fork.
    // Then kill the old sidecar (handle_kill teardown discipline) and spawn a fresh one,
    // with the create payload selected by `resume_at_uuid`:
    //   * Some(uuid) — the fork-at-point leg:
    //       create { resume: resume_from, resumeSessionAt: uuid, forkSession: true,
    //                resumeDropsTurn: <guard uuid> }
    //   * None (r2: rollback to BEFORE the first message): create a FRESH conversation with
    //     NO resume keys at all (no resumeSessionId/resumeSessionAt/forkSession) — the
    //     empty fresh transcript IS the rollback target. The discarded session is already
    //     recorded as original_session_id/original_tip_uuid; canRedo = the original tip
    //     strictly beyond the live tip (none ⇒ the recorded tip qualifies); a later redo
    //     re-forks the ORIGINAL at THE LAST RAW-CHAIN UUID OF THE RESTORED FIRST STEP'S
    //     GROUP — its assistant tail (r3: `a1` for the u1/a1 step, never the first
    //     user-anchor uuid itself) — the proved full-retention fork-at-point path —
    //     and adopts.
    // where guard uuid (Some leg only) = the ORIGINAL chain tip uuid (the same value stored
    // as original_tip_uuid): any resume that would have to drop at-or-past the tip is a
    // resolver bug and must loudly refuse rather than silently mis-fork. A create whose
    // early sidecar output begins with the refusal prefix
    // `Resume rejected by --resume-drops-turn:` is retried ONCE with resumeDropsTurn
    // omitted — the plain-resume recovery per the SDK docs — before any other error
    // mapping. Adoption (BOTH legs) rides the EXISTING consumer:
    // sdk.session.init inserts the new cli id in cli_index and AWAIT-writes the binding
    // (pass supersedes: old durable id) — that SAME awaited batch RE-KEYS the rollback row
    // old->new, so the record follows the pane atomically with the binding. A fork/create
    // failure after the successful pre-write first COMPENSATES the record (rewrites `existing`,
    // or an empty record) before the refusal is answered — the ledger never describes a
    // rollback the provider rejected.
    ... (mirror handle_create's spawn+create-write legs against spawn_sidecar; the create
    payload gains "resumeSessionAt": resume_at_uuid, "forkSession": true,
    "resumeSessionId": resume_from, "resumeDropsTurn": original_tip_uuid — the Some leg
    ONLY; the None leg sends a plain create with none of these keys)

    let new_id = /* adopted cli id from the sdk.session.init await */;

    let removed_ids: Vec<String> = removed_turns.iter().filter_map(|t| t.get("turnId").or_else(|| t.get("id")).and_then(Value::as_str).map(str::to_string)).collect();
    let old_id = op.session_id.clone();
    // Re-stamp the op for the NEW live id so every outbound frame names the adopted session:
    let switch = RollbackRequest { session_id: new_id.clone(), ..op };
    // Pane re-key: the existing freshAgent.session.materialized broadcast (old -> new):
    self.broadcast_materialized(&old_id, &new_id, &session_type); // reuse the exact materialize emission the attach-mint-new leg already uses
    self.broadcast(&rollback_broadcast_frame(&switch, &new_id, &removed_ids, record.can_redo()));
    reply_sink(rollback_ack_frame(&switch, &new_id, Some(&prompt_text), &removed_ids, record.can_redo(), Some(&new_id)));
}
```

`redo_resume_target` + `restored_slice_turns` are pure uuid-math helpers unit-tested in `claude_snapshot.rs` (write the tests for them alongside the ones above — r3 boundary rule: every resume point is THE LAST UUID OF THE TARGET STEP'S RAW-CHAIN GROUP, its assistant tail: Step from a 2-uuid prefix against the 4-uuid original → `a2`; toTurn("u2") → `a2`; toTurn on unknown uuid → Err; prefix == original → Ok(None); EMPTY current transcript — the r2 first-turn case — → `a1` — the uuid ending the ORIGINAL's first step group (u1/a1), NOT the first user-anchor uuid `u1`).

4. `handle_send` (claude.rs:743): after resolve and BEFORE the sidecar write — with `turn_lock` held and `in_turn` SET under it first (item 1; the check-then-set window vs `handle_rollback` is closed; `handle_send` NEVER acquires/consults `rollback_in_flight` — while a rollback holds the turn lock the send waits on the lock, then proceeds) — `destroy_redo_on_submit(&self.identity_sink, "claude", &durable_id, now)` (warn-only on failure; opencode leg shows the pattern).

`crates/freshell-ws/src/terminal.rs`: claude arms (provider Claude — both freshclaude and kilroy session types ride it):

```rust
ClientMessage::FreshAgentUndo(m) => {
    if is_codex_provider(m.provider) { /* Task 2 arm */ }
    else if m.provider == AgentProvider::Opencode { /* Task 3 arm */ }
    else if m.provider == AgentProvider::Claude {
        let fresh_claude = state.fresh_claude.clone();
        let conn_sink = conn_sink.clone();
        tokio::spawn(async move { fresh_claude.handle_rollback(RollbackRequest::from_undo(m), conn_sink).await }.instrument(tracing::Span::current()));
    } else {
        conn_sink(rollback_refusal_frame(&RollbackRequest::from_undo(m), "Undo is")); // amplifier: permanent
    }
    true
}
// FreshAgentRedo: same fan-out minus the codex cell (its permanent refusal stays).
```

`crates/freshell-claude-sidecar` requires `npm ci` in that directory before its first local run here (vendored node_modules; per workspace-baseline). The integration test spawns node directly on the fake — no sidecar dependencies needed for the TEST; the REAL sidecar change is covered by the fork-at-point option passthrough being exercised in e2e (Task 7) — add one inline comment in index.mjs noting the wire keys are covered by `freshagent_claude_rollback.rs` + the e2e spec.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent claude && cargo test -p freshell-ws --test freshagent_claude_rollback && cargo test -p freshell-ws --test freshagent_rollback_refusal`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Review `handle_rollback` length: if the spawn+create-write leg duplicates `handle_create`/`resume_for_attach` blocks, extract a `spawn_sidecar_with_create(create_payload_json)` helper shared by those paths (behavior identical; the only new fields are the two option keys). Keep uuid math entirely in `claude_snapshot.rs`. No behavior change.

- [ ] **Step 6: Run impacted-test verification**

Impacted: every claude slice test (turn-id change ripples claude snapshot expectations — the synthetic `{thread}:{ordinal}` pins in this file's existing tests must be updated to the uuid form, which is exactly the intended behavior change), the ws integration suite, and the sidecar boundary.

Run: `cargo test -p freshell-freshagent && cargo test -p freshell-ws && npm run test:vitest -- run test/unit/shared/fresh-agent-turns.test.ts && cargo clippy --workspace --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-claude-sidecar/index.mjs crates/freshell-freshagent/src/claude.rs crates/freshell-freshagent/src/claude_snapshot.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/freshagent_claude_rollback.rs crates/freshell-ws/tests/freshagent_rollback_refusal.rs
git commit -m "feat(fresh-claude): undo/redo via resume+resumeSessionAt+forkSession fork-at-point (kata 1wxv task 4)"
```

---

### Task 5: Snapshot surfacing — capability stamps, rolledBackTurns marker bucket, revision floor

**Stage-2 binding amendments (from "## Load-bearing corrections", items 1 & 4):**
- Codex capability stamp is session-scoped by history mode: `{undo:true, redo:false}` ⟺ `CodexSession.history_mode == Some(Paginated)`; `{undo:false, redo:false}` for legacy threads AND for `None` — where `None` now means ONLY "the durable read found no parseable mode" (r3: resumed/adopted threads get their mode from the rollout's persisted `session_meta.history_mode` — validator-C proved persistence; freshell-codex already reads rollouts for durability — so a paginated thread keeps undo after normal rehydration; capability still never over-advertised). Never probed live per snapshot (the app-server exposes no mode read-back; the durable rollout meta is the source of truth, cached on the session record).
- Claude/kilroy: `{undo:true, redo:true}` statically (no SDK capability query exists); old-CLI runtime failure classifies to `UNSUPPORTED_CAPABILITY` refusal at op time (never `INTERNAL_ERROR`).
- ~~Spawn-time version recording for all three providers~~ — SUPERSEDED (Task-5 review Minor-1, explicitly dispositioned): refusal classification is error-shape-driven on all three lanes (codex -32600/-32601-or-unknown-method ⇒ legacy/old-CLI copies; opencode 404 ⇒ OPENCODE_OLD_CLI_COPY; claude explicit failure fold), and no pinned refusal copy consumes a detected version. Capturing `--version` costs one extra process spawn per session spawn and duplicates diagnostics already present at the provider error site; not required by the request. Follow-up recording lives in the progress ledger.

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs:3620-3663` (`build_codex_snapshot_json` gains a `rollback: Option<&RollbackRecord>` param; `get_snapshot` call sites load the record)
- Modify: `crates/freshell-freshagent/src/lib.rs:1439-1495` (`build_opencode_snapshot_json` same param; `get_opencode_snapshot` loads the record)
- Modify: `crates/freshell-freshagent/src/claude_snapshot.rs` (`build_claude_snapshot_json` + `get_claude_snapshot` gain the record-aware bucket: LCP against the original transcript; revision floor) and `crates/freshell-freshagent/src/snapshot.rs:90-192` (route arms load the record via each state’s `identity_sink` and pass it in)
- Test: in-file builder tests in each of the three files

**Interfaces:**
- Consumes: Task 1 record plumbing; Task 2/3 record contents (codex/opencode `entries`); Task 4 claude `original_session_id` + `locate_transcript`; the existing `apply_pending_overlay` route leg (claude).
- Produces: every fresh-agent snapshot additionally carries `capabilities.undo`/`capabilities.redo` (stamps per Wire Design), optional `rolledBackTurns` (FreshAgentTurn JSON with `rolledBack:true`), optional `rollback: {canRedo, undoneDepth}`, and a revision that never regresses across rollback (`max(basis, record.last_op_at_ms)`).

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-freshagent/src/codex.rs` — append to snapshot tests:

```rust
In all three files the tests call the builder through the file's OWN existing snapshot-fixture harness (the same raw-turn/message/transcript inputs today's snapshot tests use); the ONLY changes vs. those calls are the new trailing `Option<&RollbackRecord>` param and the assertions below. Pin this assertion shape verbatim:

```rust
// codex.rs — build the snapshot via the file's existing `build_codex_snapshot_json`
// fixture call (revision basis 7), passing `Some(&record)` where `record` is a
// RollbackRecord with one entry { removed_turns: [turn-9 USER-role display json] (r3: undoneDepth is the
// user-role step count of the bucket — the fixture's one user turn yields 1), prompt_text: "later", at_ms: 100 }.
// The fixture session's stored history mode is "paginated" (the stamp is session-scoped):
    assert_eq!(snap["capabilities"]["undo"], json!(true));
    assert_eq!(snap["capabilities"]["redo"], json!(false));
    assert_eq!(snap["rollback"], json!({"canRedo": false, "undoneDepth": 1}));
    let bucket = snap["rolledBackTurns"].as_array().expect("bucket");
    assert_eq!(bucket.len(), 1);
    assert_eq!(bucket[0]["rolledBack"], json!(true));
    assert_eq!(bucket[0]["turnId"], json!("turn-9"));
    assert_eq!(snap["revision"], json!(100), "the record's lastOpAtMs is the revision floor");
// ...a LEGACY-mode fixture variant (session record stamped legacy) asserts
// `snap["capabilities"]["undo"] == json!(false)` — the hard-coded `"undo": true`
// does not exist;
// ...and the None-record call variant asserts `snap.get("rolledBackTurns").is_none()`
// and `snap.get("rollback").is_none()`.

// lib.rs — opencode builder twin, `Some(&record)` with one entry over msg_u2 and the
// record built via `set_can_redo(true, ..)` (the stored bit is the only source):
    assert_eq!(snap["capabilities"]["undo"], json!(true));
    assert_eq!(snap["capabilities"]["redo"], json!(true));
    assert_eq!(snap["rollback"], json!({"canRedo": true, "undoneDepth": 1}));
    assert_eq!(snap["rolledBackTurns"][0]["rolledBack"], json!(true));
// ...a TWO-STEP-UNDO variant (r3, finding 5): a single rebuilt entry carrying the
// [msg_u2, msg_a2, msg_u3, msg_a3] tail asserts undoneDepth == 2 — the USER-role step
// count of the bucket (and the same count the client label shows), never entries.len() (1);
// ...and with `record.destroy_redo(..)` (clears the stored bit): rollback.canRedo == false
// while the bucket still has length 1 (decision 6; undoneDepth still counts the user steps).

// claude_snapshot.rs — tmp CLAUDE_HOME: original.jsonl = u1 a1 u2 a2 (uuid-chained),
// current.jsonl = u1 a1; record.original_session_id = Some(<original id>),
// record.original_tip_uuid = Some("a2"), set_can_redo(true), AND record.entries carrying
// the undo-op-recorded [u2, a2] turn json (r3: the bucket is the ledger union, durable even
// if the original's JSONL is later compacted/GC'd):
    assert_eq!(snap["capabilities"]["undo"], json!(true));
    assert_eq!(snap["capabilities"]["redo"], json!(true));
    let bucket = snap["rolledBackTurns"].as_array().expect("bucket");
    let ids: Vec<&str> = bucket.iter().filter_map(|t| t["turnId"].as_str()).collect();
    assert_eq!(ids, vec!["u2", "a2"], "the marker bucket is the ledger entries union");
    assert!(bucket.iter().all(|t| t["rolledBack"] == json!(true)));
    assert_eq!(snap["rollback"], json!({"canRedo": true, "undoneDepth": 1})); // user-role count of the bucket
// ...a variant whose original.jsonl is EXTENDED past the recorded tip (tip moved)
// asserts rollback.canRedo == false (the snapshot re-reads the CHAIN ROOT's tip and
// requires equality — current-epoch redo state comes from the chain root; no device
// shows a redo that Task 4 would refuse);
// ...an r2 first-turn variant (the fresh-conversation leg): entries carry ALL of [u1,a1,u2,a2]
// (recorded when the first-turn undo ran) and the same original record asserts the bucket
// == all four and rollback.canRedo == true (live tip none ⇒ the original tip counts as
// strictly beyond);
// ...a UNION variant (r3): entries = old-epoch [o1,o2-turns] ++ current-epoch [u2,a2]
// asserts the bucket shows BOTH epochs in order (markers persist marked — the original
// transcript is NOT needed to keep them);
// ...re-run with `record.destroy_redo(..)`: same bucket, canRedo false; one
// assertion leg re-runs the whole fixture with session_type "kilroy" (identical stamps).
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent snapshot`

Expected: FAIL because the builders emit no undo/redo capability keys, no `rolledBackTurns`, no `rollback` block, and no revision floor (compile errors on the new param + assertion failures).

- [ ] **Step 3: Add the minimal production implementation**

Codex (`build_codex_snapshot_json`, codex.rs:3620): add `rollback: Option<&RollbackRecord>` param; capabilities map gains `"undo": <session.history_mode == Some(HistoryMode::Paginated)>, "redo": false` — the mode comes from `CodexSession.history_mode` (Task 2 fills it at `thread/start` AND rehydrates it at resume/adoption from the rollout's persisted `session_meta.history_mode` — r3; `None` only when that durable meta is missing/unparseable ⇒ legacy), NEVER live-probed per snapshot (no read-back exists; the durable rollout meta cached on the session record is the SoT), so legacy AND unknown sessions stamp `undo:false` (no hard-coded `"undo": true` line exists); when `Some(record)` and `!record.entries.is_empty()`: `"rolledBackTurns": <flattened entries (the r3 union) with "rolledBack": true injected per turn>`, `"rollback": {"canRedo": record.can_redo(), "undoneDepth": <r3: count of USER-role turns in the flattened bucket — the same user-step count the client's `Rolled back (N)` label shows, NEVER entries.len()>}`; final `revision = max(basis, record.last_op_at_ms)`. `get_snapshot` loads the record (`self.identity_sink.as_ref().and_then(|s| s.load_rollback("codex", thread_id))`) and passes it.

Opencode (`build_opencode_snapshot_json`, lib.rs:1439): params + capabilities `"undo": true, "redo": true`; bucket from `record.entries` (the r3 union — frozen prior-epoch markers ++ the current serve-revert tail); `"rollback": {"canRedo": record.can_redo(), "undoneDepth": <r3: count of USER-role turns in the marker bucket — with a rebuilt single-entry tail over [u2,a2,u3,a3] this is 2 (two undone user steps), NOT entries.len() (1) — the same user-step count the `Rolled back (N)` label shows>}`; revision floor. `get_opencode_snapshot` loads + passes.

Claude (`claude_snapshot.rs`): `build_claude_snapshot_json` gains the capability stamps (`"undo": true, "redo": true` — static; approvals/questions stay presence-driven). The bucket is LEDGER-SOURCED (r3 — no longer computed purely from a read-time LCP): when a record is present, its `entries` union is projected with `rolledBack: true` (durable even if an old original's JSONL is later compacted/GC'd); `canRedo = record.can_redo() && raw_chain_tip(original) == record.original_tip_uuid` — the CURRENT-epoch redo state still comes from the chain root: when `record.original_session_id` is `Some(original)` and `locate_transcript(original)` hits, the original's tip is RE-READ at snapshot time and a moved tip forces `canRedo:false` so no device shows a redo that Task 4 would refuse with `REDO_REMOVED_HISTORY_COPY`; `undoneDepth` = number of USER-role turns in the bucket (r3 — the same user-step count as the label); revision = `max(mtime_or_count, record.last_op_at_ms)`. `snapshot.rs` route arms load the record per provider (`codex`/`opencode` states load inside their get_snapshot methods as above; the claude route loads in its arm and passes to `get_claude_snapshot`'s new param — pick the single-seam-per-provider split and apply it consistently in all three arms).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent snapshot && cargo test -p freshell-freshagent lib::tests && cargo test -p freshell-freshagent codex::tests && cargo test -p freshell-freshagent claude_snapshot`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Extract one shared `fn stamp_rollback_bucket(base: &mut Value, record: Option<&RollbackRecord>, provider: &str)` in `rollback_record.rs` used by all three builders if the bucket-injection shape is genuinely identical for codex/opencode (claude's read-time LCP leg stays local). No behavior change.

- [ ] **Step 6: Run impacted-test verification**

The strict snapshot schema now receives new keys from every builder: the whole freshagent surface plus the client contract tests and any snapshot fixture assertions.

Run: `cargo test -p freshell-freshagent && cargo test -p freshell-ws && npm run test:vitest -- run test/unit/shared test/unit/client/store/freshAgentSlice.test.ts && npm run test:vitest -- run test/unit/port/ws-contract-freeze.test.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/claude_snapshot.rs crates/freshell-freshagent/src/snapshot.rs crates/freshell-freshagent/src/rollback_record.rs
git commit -m "feat(fresh-agent): surface rollback capabilities, marker bucket, redo availability in snapshots (kata 1wxv task 5)"
```

---

### Task 6: Client — slash commands, per-turn affordances, composer refill, attention revoke, rolled-back section

**Files:**
- Create: `src/lib/fresh-agent-rollback.ts` (pinned copy constants + `gateRollbackCommand` pure gate + `buildRollbackFrame` + ack/error type guards)
- Modify: `src/components/fresh-agent/FreshAgentComposer.tsx` (`FreshAgentComposerHandle` gains `replaceText`; :53-57 handle type, :205-216 implementation; AND the submit path's RESERVED-slash intercept at `sendText`/`executeSlashText` :337-346/:390-409 per r3 correction 8 — the pre-catalog-resolution seam, with the new `onReservedRollbackCommand` prop)
- Modify: `src/components/fresh-agent/FreshAgentTurnActions.tsx` (`TurnActionCallbacks` gains rollback slots; `buildTurnActionItems` gains "Undo to here"/"Redo to here"; hover toolbar gains the `Undo2` icon button beside the fork button)
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx` (thread new callbacks through `TurnActionProps`; render the rolled-back section)
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:78-89` (`SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS` gains the four rollback event types), `:1096-1124` (`runSlashCommand` undo/redo branches), ws-subscribe effect (:1650-1717: ack/error interception + refill), icons wiring in the `content` memo (:2492-2512), pane-action registration effect
- Modify: `src/lib/fresh-agent-ws.ts:191-359` (new fold cases; rollback-flagged errors skip `sessionError`)
- Modify: `src/store/turnCompletionAttention.ts` (new `revokeFreshAgentAttention`)
- Modify: `src/lib/pane-action-registry.ts` (fresh-agent section) + `src/components/context-menu/menu-defs.ts:709-826` (fresh-agent branch: "Undo last turn"/"Redo last turn")
- Modify: `docs/index.html` (mention /undo, /redo, and the per-turn rollback icon in the fresh-agent feature list)
- Test: `test/unit/client/lib/fresh-agent-rollback.test.ts` (create), `test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx` (append), `test/unit/client/components/fresh-agent/FreshAgentTurnActions.test.tsx` (append), `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx` (append), `test/unit/client/lib/fresh-agent-ws.test.ts` (append), `test/unit/client/store/turnCompletionAttention.test.ts` (append), `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` (append, following the file's own /fork-capability test pattern)

**Interfaces:**
- Consumes: Task 1 frames/schemas/catalog; Tasks 2–5 wire behavior + snapshot surface; existing client seams — `sendFreshAgentMessage` (View :812-823), `composerRef` (View :682), notice banner state (View :655, render :2443), `isBusy`/`effectiveStatus` (View :2079-2083), `buildTurnActionItems` + toolbar (TurnActions), `mergeSnapshotForDisplay` shrink rule (View :173-200), `dismissTabGreen` (turnCompletionAttention.ts:51-64), `selectPaneBySessionKey` (:16-43).
- Produces:
  - `src/lib/fresh-agent-rollback.ts`:
    ```ts
    export const ROLLBACK_BUSY_UNDO_NOTICE = 'Undo is unavailable while the agent is mid-turn — queue a message to steer it, or wait for the turn to finish.'
    export const ROLLBACK_BUSY_REDO_NOTICE = 'Redo is unavailable while the agent is mid-turn — queue a message to steer it, or wait for the turn to finish.'
    export const REDO_CODEX_UNSUPPORTED_NOTICE = 'Redo is not available for Codex sessions — undo permanently replaces codex thread history (codex has no redo primitive). Rolled-back turns stay listed below the transcript.'
    export const REDO_DESTROYED_NOTICE = 'Redo is no longer available — a message submitted after the undo permanently retired it.'
    export const UNDO_REFILL_NOTICE = 'Undone — the removed prompt is back in the composer for editing.'
    export function rollbackUnsupportedNotice(providerLabel: string): string // `Conversation rollback is not supported for ${providerLabel} sessions.`
    export type RollbackGate = { kind: 'send' } | { kind: 'reject'; notice: string }
    export function gateRollbackCommand(input: {
      direction: 'undo' | 'redo'
      provider: string
      providerLabel: string
      capabilityUndo: boolean | undefined
      capabilityRedo: boolean | undefined
      canRedo: boolean | undefined
      isBusy: boolean
      hasRolledBackTurns: boolean
    }): RollbackGate
    export function buildRollbackFrame(input: {
      direction: 'undo' | 'redo'
      requestId: string
      sessionId: string
      sessionType: string
      provider: string
      cwd?: string
      mode?: 'step' | 'toTurn'
      turnId?: string
    }): Record<string, unknown>
    export function asRollbackAck(event: unknown): { kind: 'freshAgent.rolledBack' | 'freshAgent.redone'; requestId: string; removedPromptText?: string; canRedo?: boolean } | null
    export function isRollbackErrorEvent(event: unknown): boolean // event.type === 'freshAgent.error' && event.rollback === true
    ```
  - `FreshAgentComposerHandle.replaceText(text: string): void` (replaces content, syncs sessionStorage via the existing persist effect, focuses, caret to end).
  - `TurnActionCallbacks` extended: `canRollback?: boolean`, `rollbackBusy?: boolean`, `canRedo?: boolean`, `onRollbackToTurn?: (turnId: string) => void`, `onRedoToTurn?: (turnId: string) => void`.
  - `revokeFreshAgentAttention(sessionKey: string)` thunk.
  - `registerFreshAgentPaneActions(paneId: string, actions: FreshAgentPaneActions): () => void` + `getFreshAgentPaneActions(paneId)` in the pane-action registry, where `FreshAgentPaneActions = { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean }`.

- [ ] **Step 1: Write the failing behavioral test**

`test/unit/client/lib/fresh-agent-rollback.test.ts` — create:

```ts
import { describe, expect, it } from 'vitest'
import {
  buildRollbackFrame,
  gateRollbackCommand,
  asRollbackAck,
  isRollbackErrorEvent,
  ROLLBACK_BUSY_UNDO_NOTICE,
  ROLLBACK_BUSY_REDO_NOTICE,
  REDO_CODEX_UNSUPPORTED_NOTICE,
  REDO_DESTROYED_NOTICE,
  rollbackUnsupportedNotice,
} from '@/lib/fresh-agent-rollback'

const idleCapable = {
  direction: 'undo' as const,
  provider: 'opencode', providerLabel: 'OpenCode',
  capabilityUndo: true, capabilityRedo: true, canRedo: true,
  isBusy: false, hasRolledBackTurns: true,
}

describe('gateRollbackCommand', () => {
  it('sends when idle and capable', () => {
    expect(gateRollbackCommand(idleCapable)).toEqual({ kind: 'send' })
  })
  it('rejects mid-turn with the steer/queue pointer (decision 7)', () => {
    expect(gateRollbackCommand({ ...idleCapable, isBusy: true })).toEqual({ kind: 'reject', notice: ROLLBACK_BUSY_UNDO_NOTICE })
    expect(gateRollbackCommand({ ...idleCapable, direction: 'redo', isBusy: true })).toEqual({ kind: 'reject', notice: ROLLBACK_BUSY_REDO_NOTICE })
  })
  it('rejects explicitly when the provider lacks the capability (decision 9)', () => {
    expect(gateRollbackCommand({ ...idleCapable, capabilityUndo: false })).toEqual({ kind: 'reject', notice: rollbackUnsupportedNotice('OpenCode') })
    expect(gateRollbackCommand({ ...idleCapable, capabilityUndo: undefined })).toEqual({ kind: 'reject', notice: rollbackUnsupportedNotice('OpenCode') })
  })
  it('codex redo gets the explicit decision-5 copy, not a generic rejection', () => {
    expect(gateRollbackCommand({ ...idleCapable, direction: 'redo', provider: 'codex', providerLabel: 'Codex', capabilityRedo: false }))
      .toEqual({ kind: 'reject', notice: REDO_CODEX_UNSUPPORTED_NOTICE })
  })
  it('redo with a destroyed/absent boundary says so (decision 5)', () => {
    expect(gateRollbackCommand({ ...idleCapable, direction: 'redo', canRedo: false }))
      .toEqual({ kind: 'reject', notice: REDO_DESTROYED_NOTICE })
    expect(gateRollbackCommand({ ...idleCapable, direction: 'redo', canRedo: true, hasRolledBackTurns: false }))
      .toEqual({ kind: 'reject', notice: 'Nothing to redo.' })
  })
})

describe('buildRollbackFrame', () => {
  it('builds the frozen undo frame', () => {
    expect(buildRollbackFrame({ direction: 'undo', requestId: 'r1', sessionId: 's1', sessionType: 'freshcodex', provider: 'codex' }))
      .toEqual({ type: 'freshAgent.undo', requestId: 'r1', sessionId: 's1', sessionType: 'freshcodex', provider: 'codex' })
  })
  it('builds a toTurn redo frame', () => {
    expect(buildRollbackFrame({ direction: 'redo', requestId: 'r2', sessionId: 's1', sessionType: 'freshopencode', provider: 'opencode', mode: 'toTurn', turnId: 'msg_u2', cwd: '/w' }))
      .toEqual({ type: 'freshAgent.redo', requestId: 'r2', sessionId: 's1', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w', mode: 'toTurn', turnId: 'msg_u2' })
  })
})

describe('wire guards', () => {
  it('parses acks and ignores everything else', () => {
    expect(asRollbackAck({ type: 'freshAgent.rolledBack', requestId: 'r1', removedPromptText: 'p' })?.kind).toBe('freshAgent.rolledBack')
    expect(asRollbackAck({ type: 'freshAgent.redone', requestId: 'r2' })?.kind).toBe('freshAgent.redone')
    expect(asRollbackAck({ type: 'freshAgent.session.changed' })).toBeNull()
    expect(asRollbackAck(null)).toBeNull()
  })
  it('detects rollback-marked error events only', () => {
    expect(isRollbackErrorEvent({ type: 'freshAgent.error', rollback: true, code: 'BUSY_TURN' })).toBe(true)
    expect(isRollbackErrorEvent({ type: 'freshAgent.error', code: 'BUSY_TURN' })).toBe(false)
    expect(isRollbackErrorEvent({ type: 'freshAgent.error', rollback: true, code: 'INVALID_SESSION_ID' })).toBe(true)
  })
})
```

`test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx` — append:

```ts
it('replaceText overwrites the box (decision 4: replace, never append) and focuses', () => {
  const ref = createRef<FreshAgentComposerHandle>()
  render(<FreshAgentComposer ref={ref} storageKey="t-rb" onSend={() => {}} />)
  act(() => { ref.current?.insertText('old draft') })
  act(() => { ref.current?.replaceText('removed prompt') })
  const textarea = screen.getByRole('textbox', { name: /chat message input/i }) as HTMLTextAreaElement
  expect(textarea.value).toBe('removed prompt')
  expect(document.activeElement).toBe(textarea)
  expect(window.sessionStorage.getItem('t-rb')).toBe('removed prompt')
})

// r3 correction 8: the composer's submit path intercepts RESERVED rollback names BEFORE
// catalog resolution, so a capability-filtered-out command never falls through to onSend.
it('typed /redo unresolvable against the catalog calls onReservedRollbackCommand and NEVER onSend', () => {
  // Render the composer with a catalog that lacks /redo (the freshcodex shape) and an
  // onReservedRollbackCommand spy; type '/redo' + Enter via the textbox:
  //   expect(onReservedRollbackCommand).toHaveBeenCalledWith('redo')
  //   expect(onSend).not.toHaveBeenCalled()
  //   the box is cleared and the text is pushed to history exactly like a resolved command.
})
it('typed /redo resolvable against the catalog still dispatches the normal command path', () => {
  // Catalog WITH /redo (freshopencode shape): onCommand receives the redo command,
  // onReservedRollbackCommand is NOT consulted.
})
```

`test/unit/client/components/fresh-agent/FreshAgentTurnActions.test.tsx` — append:

```ts
describe('rollback affordance (kata 1wxv decisions 3, 8)', () => {
  const userTurn = (): FreshAgentTurn => ({
    id: 'u2', turnId: 'u2', role: 'user', summary: 'prompt two',
    items: [{ id: 'i1', kind: 'text', text: 'prompt two' }],
  })

  it('Undo to here runs the callback with the opaque display turn id', () => {
    const onRollbackToTurn = vi.fn()
    const items = buildTurnActionItems(userTurn(), { canFork: true, canRollback: true, onRollbackToTurn })
    expect(items.find((i) => i.label === 'Undo to here')?.disabled).toBe(false)
    items.find((i) => i.label === 'Undo to here')?.run()
    expect(onRollbackToTurn).toHaveBeenCalledWith('u2')
  })

  it('is disabled for non-user turns and when busy, hidden when unsupported', () => {
    const assistant = { ...userTurn(), role: 'assistant' as const }
    const cb = { canFork: true, canRollback: true, onRollbackToTurn: vi.fn() }
    expect(buildTurnActionItems(assistant, cb).find((i) => i.label === 'Undo to here')?.disabled).toBe(true)
    expect(buildTurnActionItems(userTurn(), { ...cb, rollbackBusy: true }).find((i) => i.label === 'Undo to here')?.disabled).toBe(true)
    expect(buildTurnActionItems(userTurn(), { canFork: true, canRollback: false }).find((i) => i.label === 'Undo to here')?.disabled).toBe(true)
  })

  it('the hover toolbar renders the rollback icon beside the fork icon with a step-naming tooltip', () => {
    render(
      <FreshAgentTurnActions
        turn={userTurn()}
        canFork
        onForkFromTurn={() => {}}
        canRollback
        onRollbackToTurn={() => {}}
      />,
    )
    const button = screen.getByRole('button', { name: 'Undo to here' })
    expect(button).toHaveAttribute('title', expect.stringContaining('prompt two'))
  })
})
```

`test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx` — append (written in Step 1 with the other suites; the section does not exist pre-implementation, so these fail red):

```ts
describe('rolled-back section (kata 1wxv decision 6)', () => {
  it('renders nothing when rolledBackTurns is empty', () => {
    // render a transcript with turns + rolledBackTurns: [] -> no 'Rolled back turns' region
    expect(screen.queryByRole('region', { name: 'Rolled back turns' })).toBeNull()
  })
  it('renders the marker rows with the USER-STEP count label (r3 correction 5)', () => {
    // rolledBackTurns = [user u2, assistant a2, user u3, assistant a3] (two undone steps)
    // -> the label reads 'Rolled back (2)' — the same user-step count rollback.undoneDepth
    // carries — never the raw row count (4).
  })
  it('per-row Redo to here fires onRedoToTurn only on user rows when canRedo', () => {
    // canRedo=true: user rows expose role=button name 'Redo to here' calling onRedoToTurn(turnId);
    // assistant rows never expose the button; canRedo=false exposes none.
  })
})
```

`test/unit/client/store/turnCompletionAttention.test.ts` — append:

```ts
it('revokeFreshAgentAttention is PANE-SCOPED and re-derives tab attention (r3 correction 7)', () => {
  // Build the store rig exactly this file's dismissTabGreen tests use, with TWO panes in
  // the SAME tab (a split): the rollback owner pane resolves sessionKey 'opencode:ses_1';
  // the sibling pane is unrelated (another fresh-agent session or terminal with its own
  // completion). Mark attention on BOTH panes (tab attention derived set) AND on an
  // unrelated tab; run revoke; assert:
  //   - the OWNER pane's attention entry is cleared;
  //   - the SIBLING pane's attention entry SURVIVES (rollback revokes only the undone
  //     turn's attention, never unrelated completions in the same tab);
  //   - TAB-level green is the OR over remaining panes: attentionByTab[tabId] is STILL SET
  //     (derived from the surviving sibling — never blanket-dismissed);
  //   - the unrelated tab is untouched.
  // Second variant (single-pane tab): owner cleared AND attentionByTab[tabId] cleared.
  expect(getState().turnCompletion.attentionByTab[ownerTabId]).toBeDefined()
  expect(getState().turnCompletion.attentionByPane[siblingPaneId]).toBeDefined()
  expect(getState().turnCompletion.attentionByPane[ownerPaneId]).toBeUndefined()
  expect(getState().turnCompletion.attentionByTab[strangerTabId]).toBeDefined()
})
```

`test/unit/client/lib/fresh-agent-ws.test.ts` — append:

```ts
describe('rollback folds (kata 1wxv)', () => {
  it('freshAgent.session.rolledBack revokes attention for the owning pane', () => {
    // dispatch handleFreshAgentTransportEvent for a session.rolledBack envelope;
    // assert the thunk cleared the seeded pane/tab attention (mirror the file's dispatch-spy rig).
  })
  it('rollback-flagged errors do not hit the pane error surface', () => {
    // seed dispatch spy; send freshAgent.event{freshAgent.error{code:'BUSY_TURN', rollback:true, requestId}};
    // assert sessionError was NOT dispatched and the fold returned true.
    // INVALID_SESSION_ID with rollback:true still dispatches markSessionLost.
  })
  it('acks + session.redone are consumed without redux writes', () => {
    // freshAgent.rolledBack / freshAgent.redone / freshAgent.session.redone folds return true
    // and dispatch nothing (ack consumption lives in the pane view; invalidation rides the set).
  })
})

`test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` — append (patterns from the file's own capability tests; written in Step 1 with the other suites so Step 2's failures are reachable pre-implementation):

```ts
describe('/undo + /redo dispatch (kata 1wxv)', () => {
  it('/undo sends freshAgent.undo when idle+capable; writes nothing and shows the busy UNDO notice mid-turn', () => {
    // select the catalog /undo (or type it on a capable pane): the ws-send spy receives the
    // frozen frame; with isBusy true, NO frame is sent and the notice shows
    // ROLLBACK_BUSY_UNDO_NOTICE verbatim.
  })
  it('/redo mid-turn shows the busy REDO notice (direction-correct copy) and writes nothing', () => {
    // ROLLBACK_BUSY_REDO_NOTICE verbatim; the ws-send spy stays silent.
  })
  it('typed /redo on a freshcodex pane hits the composer RESERVED seam: pinned codex notice, NEVER a send (r3 correction 8)', () => {
    // A freshcodex pane's catalog MENU has no /redo entry (Task 1 capability filtering —
    // menu absence, pinned separately). TYPE '/redo' + Enter into the composer textbox:
    // the pre-catalog-resolution seam intercepts it — the notice banner shows
    // REDO_CODEX_UNSUPPORTED_NOTICE verbatim, and onSend/sendFreshAgentMessage NEVER fire
    // (the text never reaches the model). A typed /undo on a legacy/absent-caps pane
    // likewise intercepts with rollbackUnsupportedNotice(<providerLabel>) and no send.
  })
  it('a rollback-flagged error renders the server message VERBATIM on the notice banner', () => {
    // feed freshAgent.event{freshAgent.error{code:'REDO_UNAVAILABLE', rollback:true, requestId}}
    // carrying the claude moved-tip copy: the banner shows THAT text — never the destroyed
    // notice or client-side guess copy.
  })
})
```
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/fresh-agent-rollback.test.ts test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx test/unit/client/components/fresh-agent/FreshAgentTurnActions.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/store/turnCompletionAttention.test.ts test/unit/client/lib/fresh-agent-ws.test.ts`

Expected: FAIL because `src/lib/fresh-agent-rollback.ts`, `replaceText`, the rollback action items/icon, the rolled-back transcript section, `revokeFreshAgentAttention`, and the new folds don't exist (import/type errors), the view has no undo/redo dispatch, and the composer has no reserved-slash seam (the `FreshAgentTranscript.test.tsx` section tests and the `FreshAgentView.test.tsx` dispatch/reserved-seam tests fail HERE, pre-implementation — r3: they are never first run only after production code exists).

- [ ] **Step 3: Add the minimal production implementation**

Create `src/lib/fresh-agent-rollback.ts` exactly per Interfaces (pure, no react imports).

`src/components/fresh-agent/FreshAgentComposer.tsx`:

```ts
export type FreshAgentComposerHandle = {
  focus: () => void
  insertText: (text: string) => void
  appendText: (text: string) => void
  replaceText: (text: string) => void
}
// useImperativeHandle block (:205-216) gains:
    replaceText: (value: string) => {
      setText(value) // the :228-235 effect persists it to sessionStorage
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      })
    },
```

`src/components/fresh-agent/FreshAgentTurnActions.tsx`:

```ts
export type TurnActionCallbacks = {
  canFork: boolean
  canRollback?: boolean
  rollbackBusy?: boolean
  canRedo?: boolean
  onForkFromTurn?: (turnId: string) => void
  onRewindToTurn?: (turn: FreshAgentTurn) => void
  onRollbackToTurn?: (turnId: string) => void
  onRedoToTurn?: (turnId: string) => void
}

// buildTurnActionItems — insert between the fork item and the rewind item:
    {
      label: 'Undo to here',
      disabled: callbacks.canRollback !== true || callbacks.rollbackBusy === true || !callbacks.onRollbackToTurn || turn.role !== 'user',
      run: () => callbacks.onRollbackToTurn?.(turn.turnId ?? turn.id),
    },
// (the rollback item is conversation-only; it is deliberately NOT marked `destructive` —
//  the file-rewind sibling owns that flag. Redo rows for the rolled-back bucket are built
//  by the transcript section, not here — those rows aren't interactive articles.)

// hover toolbar — insert immediately after the fork button (:92-102), before rewind:
        {canRollback && onRollbackToTurn && turn.role === 'user' ? (
          <button
            type="button"
            onClick={() => onRollbackToTurn(turn.turnId ?? turn.id)}
            disabled={rollbackBusy === true}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Undo to here"
            title={`Roll back this turn and everything after “${turn.summary.slice(0, 60)}” — conversation only; files stay as they are`}
          >
            <Undo2 className="h-3 w-3" />
          </button>
        ) : null}
// (+ import { Undo2 } from 'lucide-react'; component props destructure the new callbacks)
```

`src/components/fresh-agent/FreshAgentTranscript.tsx`:
- `TurnActionProps` (:462-469) gains the same rollback fields; the `actions` memo (:701-707) and the toolbar/context-menu/sheet invocations pass them straight through (one props type, three consumers — no logic).
- The rolled-back section (rendered after the last live turn, inside the transcript scroll area):

```tsx
{rolledBackTurns.length > 0 ? (
  <section aria-label="Rolled back turns" className="mx-2 mt-2 rounded-md border border-dashed border-border/60 bg-muted/30 p-2 opacity-80">
    <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
      Rolled back ({rolledBackTurns.filter((t) => t.role === 'user').length}) — gone from the conversation; kept in history.
      {/* r2/r3: the count is rollback STEPS (user-role marker groups), not raw marker rows —
          one undone turn-step contributes a user row AND an assistant row. This is exactly
          the user-step count the server's rollback.undoneDepth computes (r3 correction 5):
          same bucket, same rule, never entries.len(). */}
    </p>
    {rolledBackTurns.map((turn, index) => (
      <div key={`${getFreshAgentDisplayTurnKey(turn)}:${index}`} className="flex items-start justify-between gap-2 rounded px-1 py-1">
        <div className="min-w-0">
          <span className="mr-2 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">rolled back</span>
          <span className="text-sm text-muted-foreground">{turn.summary || turnPlainText(turn)}</span>
        </div>
        {canRedo && onRedoToTurn && turn.role === 'user' ? (
          <button
            type="button"
            onClick={() => onRedoToTurn(turn.turnId ?? turn.id)}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            aria-label="Redo to here"
            title={`Restore this turn and the rolled-back turns before it (“${turn.summary.slice(0, 60)}”)`}
          >
            <Redo2 className="h-3 w-3" />
          </button>
        ) : null}
      </div>
    ))}
  </section>
) : null}
```

- New transcript props: `rolledBackTurns?: FreshAgentTurn[]`, `canRedo?: boolean`, `onRedoToTurn?: (turnId: string) => void` (the rollback-into-live-turn callbacks ride `TurnActionProps`).

`src/lib/fresh-agent-ws.ts` — new cases in `handleFreshAgentTransportEvent` before `default:`:

```ts
    case 'freshAgent.rolledBack':
    case 'freshAgent.redone':
      // Requesting-sink ack: consumed by the initiating pane's own ws subscriber
      // (composer refill); nothing redux-side.
      return true
    case 'freshAgent.session.rolledBack': {
      // Decision 10: an undone done is not done — revoke green/attention on EVERY
      // device (the initiating pane included). Never touches recordTurnComplete.
      const key = `${locator.provider}:${sessionId}`
      dispatch(revokeFreshAgentAttention(key))
      return true
    }
    case 'freshAgent.session.redone':
      return true
```

and in the `freshAgent.error` case (:343-353):

```ts
    case 'freshAgent.error':
      if (event.code === 'INVALID_SESSION_ID') {
        dispatch(markSessionLost(locator))
      } else if ((event as { rollback?: unknown }).rollback === true) {
        // Rollback rejections are routed to the initiating pane's notice banner by the
        // view's own ws subscriber (matched on requestId) — never the pane error surface.
        return true
      } else {
        dispatch(sessionError({ ...locator, code: event.code as string | undefined, message: (event.message as string) || (event.error as string) || 'Unknown error' }))
      }
      return true
```

`src/store/turnCompletionAttention.ts` — append:

```ts
/**
 * kata 1wxv decision 10: rollback revokes the rolled-back turn's attention/green on
 * this device. sessionKey is the `provider:sessionId` turn-completion namespace.
 * PANE-SCOPED (r3 correction 7): clears ONLY the owning pane's attention entry, then
 * re-derives the TAB flag as the OR over the tab's REMAINING panes — a sibling pane's
 * attention (an unrelated completion in the same tab) SURVIVES the rollback; the tab is
 * blanket-cleared only when no remaining pane still holds attention.
 */
export function revokeFreshAgentAttention(sessionKey: string) {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    const hit = selectPaneBySessionKey(getState(), sessionKey)
    if (!hit) return
    const { tabId, paneId } = hit
    const tc = getState().turnCompletion
    if (tc?.attentionByPane?.[paneId]) dispatch(clearPaneAttention({ paneId }))
    const layout = getState().panes?.layouts?.[tabId]
    const anyRemaining = layout
      ? collectPaneEntries(layout).some((entry) => entry.paneId !== paneId && getState().turnCompletion.attentionByPane?.[entry.paneId])
      : false
    if (!anyRemaining && tc?.attentionByTab?.[tabId]) dispatch(clearTabAttention({ tabId }))
  }
}
```
(`collectPaneEntries` is the same layout walker `dismissTabGreen` uses — import it alongside the existing imports in this file.)

`src/lib/pane-action-registry.ts` — append a fresh-agent section mirroring the terminal registry's Map+register/unregister-return shape:

```ts
export type FreshAgentPaneActions = {
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}
const freshAgentActions = new Map<string, FreshAgentPaneActions>()
export function registerFreshAgentPaneActions(paneId: string, actions: FreshAgentPaneActions): () => void {
  freshAgentActions.set(paneId, actions)
  return () => { freshAgentActions.delete(paneId) }
}
export function getFreshAgentPaneActions(paneId: string): FreshAgentPaneActions | undefined {
  return freshAgentActions.get(paneId)
}
```

`src/components/context-menu/menu-defs.ts` (fresh-agent branch, after the pane actions at :810-815; item shape follows this file's convention):

```ts
// compute once per menu open from the parsed fresh-agent context (`parsed.paneId`):
const faActions = parsed.paneId ? getFreshAgentPaneActions(parsed.paneId) : undefined
// items (placed after the pane actions, shape follows this file's item convention):
{ id: 'fresh-agent-undo', label: 'Undo last turn', disabled: !faActions?.canUndo, onSelect: () => faActions?.undo() },
{ id: 'fresh-agent-redo', label: 'Redo last turn', disabled: !faActions?.canRedo, onSelect: () => faActions?.redo() },
```

`src/components/fresh-agent/FreshAgentView.tsx`:

```ts
// :78-89 — SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS gains:
  'freshAgent.session.rolledBack',
  'freshAgent.session.redone',
  'freshAgent.rolledBack',   // the requesting pane's ack also refetches
  'freshAgent.redone',

// near sendFork (:1077) add:
  const pendingRollbackRef = useRef<Map<string, { direction: 'undo' | 'redo' }>>(new Map())
  const sendRollback = useCallback((direction: 'undo' | 'redo', mode: 'step' | 'toTurn', turnId?: string) => {
    const current = paneContentRef.current
    if (!current.sessionId) return
    const cwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
    const requestId = nanoid()
    pendingRollbackRef.current.set(requestId, { direction })
    sendFreshAgentMessage(buildRollbackFrame({
      direction, requestId, sessionId: current.sessionId, sessionType: current.sessionType,
      provider: current.provider, ...(cwd ? { cwd } : {}), mode, ...(turnId ? { turnId } : {}),
    }))
  }, [sendFreshAgentMessage])

// runSlashCommand (:1096-1124) handles the CATALOG-RESOLVED undo/redo commands (the menu
// pick and the typed name that resolves against the capability-filtered catalog both end
// here). /undo and /redo are RESERVED NAMES for EVERY fresh-agent provider (r2), and the
// RESERVED-NAME seam is the COMPOSER's submit path, NOT runSlashCommand (r3 correction 8 —
// runSlashCommand only ever sees catalog-resolved commands, so a `/redo` the codex catalog
// deliberately omits would never reach it and would fall through to onSend as model text;
// the earlier in-runSlashCommand intercept referencing `commandInput` is void — it had no
// such variable in scope and lived at the wrong seam):
    if (command.action === 'undo' || command.action === 'redo') {
      const direction = command.action
      if (!current.sessionId) return
      const snapshotCaps = snapshotRef.current?.capabilities
      const gate = gateRollbackCommand({
        direction,
        provider: current.provider,
        providerLabel: descriptor.label,
        capabilityUndo: snapshotCaps?.undo,
        capabilityRedo: snapshotCaps?.redo,
        canRedo: snapshotRef.current?.rollback?.canRedo,
        isBusy,
        hasRolledBackTurns: (snapshotRef.current?.rolledBackTurns?.length ?? 0) > 0,
      })
      if (gate.kind === 'reject') {
        setNotice(gate.notice)
        return
      }
      sendRollback(direction, 'step')
      return
    }
// (introduce snapshotRef = useRef(snapshot) kept current alongside; isBusy computed above in the component.)

// The RESERVED-NAME seam (r3 correction 8) — FreshAgentComposer sendText (:390-409), BEFORE
// catalog resolution. `shared/fresh-agent-slash-commands.ts` exports
// `RESERVED_ROLLBACK_SLASH_NAMES = ['undo', 'redo'] as const` (Task 1 adds it beside the
// catalog). The composer's existing local parseSlashCommand (:97) parses the typed text;
// when the parsed name is reserved but the capability-filtered catalog does NOT resolve it
// (freshcodex /redo; any capability-false pane), the composer calls the new prop
// `onReservedRollbackCommand(direction: 'undo' | 'redo')` and returns HANDLED — the text is
// pushed to history and cleared exactly like a resolved command, and onSend is NEVER
// reached (a TYPED '/redo' on a capability-false pane never reaches the model as text):
//
//   const sendText = useCallback(() => {
//     const trimmed = text.trim()
//     ... (shell/attachment gates unchanged) ...
//     if (trimmed.startsWith('/')) {
//       if (executeSlashText(trimmed)) return
//       const parsed = parseSlashCommand(trimmed)
//       if (parsed && (RESERVED_ROLLBACK_SLASH_NAMES as readonly string[]).includes(parsed.name) && !disabled) {
//         onReservedRollbackCommand?.(parsed.name as 'undo' | 'redo')
//         pushHistory(trimmed)
//         setText('')
//         closeMenu()
//         return
//       }
//     }
//     onSend?.(trimmed, readyAttachments.map((entry) => entry.path as string))
//     ...
//
// The VIEW passes onReservedRollbackCommand so the notice copy stays view-owned:
//   onReservedRollbackCommand={(direction) => setNotice(
//     direction === 'redo' && current.provider === 'codex'
//       ? REDO_CODEX_UNSUPPORTED_NOTICE
//       : rollbackUnsupportedNotice(descriptor.label))}
// The server-side codex×redo refusal remains the wire backstop; gateRollbackCommand's codex
// branch stays as defense for the catalog-resolved and non-composer callers.

// ws-subscribe effect (:1650-1717) — after the forked leg, add:
      if (message.type === 'freshAgent.event') {
        const ack = asRollbackAck(message.event)
        if (ack && pendingRollbackRef.current.has(ack.requestId)) {
          const pending = pendingRollbackRef.current.get(ack.requestId)
          pendingRollbackRef.current.delete(ack.requestId)
          if (ack.kind === 'freshAgent.rolledBack' && pending?.direction === 'undo') {
            setLocalEcho(null) // a pending optimistic echo must not survive a rollback
            if (typeof ack.removedPromptText === 'string') {
              composerRef.current?.replaceText(ack.removedPromptText) // decision 4: overwrite refill
              setNotice(UNDO_REFILL_NOTICE)
            }
          }
        }
        const event = message.event as { code?: unknown; rollback?: unknown; requestId?: unknown }
        if (isRollbackErrorEvent(event) && pendingRollbackRef.current.has(event.requestId as string)) {
          pendingRollbackRef.current.delete(event.requestId as string)
          // The server's supplied message is PINNED SERVER-SIDE and rendered VERBATIM —
          // BUSY_TURN carries ROLLBACK_BUSY_MESSAGE; REDO_UNAVAILABLE carries the destroyed /
          // empty / claude moved-tip copy; capability failures carry their exact copy
          // (CODEX_LEGACY_THREAD_COPY / old-CLI copies / refusal parity text). The client
          // NEVER substitutes client-side guess copy for a supplied message.
          const supplied = (message.event as { message?: unknown }).message
          setNotice(typeof supplied === 'string' ? supplied : rollbackUnsupportedNotice(descriptor.label))
        }
      }

// capability-read sites beside canFork (:2308):
  const canRollback = snapshot?.capabilities?.undo === true
  const canRedoNow = snapshot?.capabilities?.redo === true && snapshot?.rollback?.canRedo === true

// content memo (:2492-2512) — the transcript gains:
//   canRollback={canRollback} rollbackBusy={isBusy} onRollbackToTurn={(id) => isBusy
//     ? setNotice(ROLLBACK_BUSY_UNDO_NOTICE)   // the busy pre-flight gate picks copy by DIRECTION
//     : canRollback ? sendRollback('undo', 'toTurn', id) : setNotice(rollbackUnsupportedNotice(descriptor.label))}
//   rolledBackTurns={snapshot?.rolledBackTurns ?? []} canRedo={canRedoNow} onRedoToTurn={(id) => isBusy
//     ? setNotice(ROLLBACK_BUSY_REDO_NOTICE)   // redo direction gets the redo busy copy
//     : canRedoNow ? sendRollback('redo', 'toTurn', id) : setNotice(REDO_DESTROYED_NOTICE)}

// pane-menu registration effect:
  useEffect(() => registerFreshAgentPaneActions(paneId, {
    undo: () => sendRollback('undo', 'step'),
    redo: () => sendRollback('redo', 'step'),
    canUndo: canRollback && !isBusy && Boolean(snapshot?.sessionId ?? paneContent.sessionId),
    canRedo: canRedoNow && !isBusy,
  }), [paneId, sendRollback, canRollback, canRedoNow, isBusy, snapshot?.sessionId, paneContent.sessionId])
```

`docs/index.html`: add to the fresh-agent feature copy — "`/undo` and `/redo` roll conversation turns back and forward (conversation only — your files are untouched), and every user turn carries an undo-to-here icon beside its fork icon."

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/lib/fresh-agent-rollback.test.ts test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx test/unit/client/components/fresh-agent/FreshAgentTurnActions.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/store/turnCompletionAttention.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx && npm run lint`

Expected: PASS (lint covers the a11y gates on the new buttons/section)

- [ ] **Step 5: Refactor while green**

Check the transcript diff: the rolled-back section should reuse the transcript's existing typography tokens rather than new ad-hoc classes if nearer conventions exist in this file. Ensure the new `TurnActionProps` fields flow through the transcript's `actions` memo without widening any unrelated memo deps. Confirm no `window.confirm` exists anywhere on the rollback path (decision 8) — grep `confirm` in the touched files must show only the pre-existing rewind call. No behavior change.

- [ ] **Step 6: Run impacted-test verification**

The view, transcript actions, slash catalog consumers, ws folds, and attention slice are broadly shared — the impacted set is the whole client unit surface plus the server-config fresh-agent contract tests.

Run: `npm run test:vitest -- run test/unit/client && npm run test:vitest -- run test/e2e/fresh-agent-turn-complete-notification.test.tsx && npm run test:vitest -- run test/unit/server/ws-fresh-agent-contract.test.ts --config config/vitest/vitest.server.config.ts && npm run lint`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/fresh-agent-rollback.ts src/components/fresh-agent src/lib/fresh-agent-ws.ts src/lib/pane-action-registry.ts src/components/context-menu/menu-defs.ts src/store/turnCompletionAttention.ts docs/index.html test/unit/client
git commit -m "feat(fresh-agent): /undo /redo commands, per-turn rollback icon, composer refill, attention revoke, rolled-back section (kata 1wxv task 6)"
```

---

### Task 7: E2E — fake extensions and the rust-chromium rollback spec

**Files:**
- Create: `test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts`
- Modify: `test/e2e-browser/fixtures/fake-opencode.cjs` (session `revert` column honored: `revert`/`unrevert` POST arms write/clear the pointer, the session payload carries it TOP-LEVEL (`session.revert = {messageID, snapshot?, diff?, partID?}` — the VERIFIED shape, never `info.revert`), the message listing NEVER hides at-or-after-boundary rows (the real serve returns the reverted tail unflagged; freshell computes the active prefix itself), `prompt_async` clears the pointer AND deletes the tail rows (the native decision-5 deletion), audit events `reverted`/`unreverted`; AND a patch-turn fixture: when booted with `FAKE_OPENCODE_PATCH_TURN=2`, the turn-2 simulation writes/modifies `<cwd>/patch-target.txt` so the rollback spec's first case is a PATCH-CARRYING turn)
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` (`thread/revert` RPC arm: operation-log row + recorded-turn prefix trim)
- Modify: `test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs` (uuid-aware transcript lines; create accepts `resumeSessionAt`/`forkSession`; **s2rk correction: forkSession mints a NEW cliSessionId and prefix-copies the parent transcript**; plain resume keeps same-id behavior)
- Modify: `test/e2e-browser/playwright.config.ts` (RUST_ONLY_SPECS + rust-chromium testMatch registration)
- Test: `test/e2e-browser/helpers/fake-claude-sdk-sidecar-control.test.ts` (append fork-at-point leg)

**Interfaces:**
- Consumes: control-spec donors — `bootClaudeLane`/`claudeLaneEnv` (:518-595), `bootOpencodeLane` (:1630-1666), `bootCodexLane` (:1238-1276), `createFreshAgentPane` (:456-466), `sendComposerText` (:491-496), `fetchSnapshot` (:430-443), `captureDurableId` (:499-516), `waitForPaneStatus`, `WsCapture` (import the shared helper — `test/e2e-browser/helpers/ws-capture.ts` — rather than re-declaring), audit-log readers; rewind-spec hover idiom (`agent-checkpoint-rewind.spec.ts`: hover `article[data-turn-index]`, toolbar `Turn actions`, `aria-label` button click).
- Produces:
  - fake-opencode audit events `reverted {sessionId, messageID}` / `unreverted {sessionId}`; session payload carries TOP-LEVEL `revert.messageID` (omitted when inactive — never `info.revert`); `GET /session/:id/message` returns ALL messages including the reverted tail, UNFLAGGED (never post-filtered).
  - fake-codex-app-server answers `thread/revert{threadId, beforeTurnId}` with `{}` and records one operation-log row; subsequent `thread/read{includeTurns:true}` returns the prefix strictly before `beforeTurnId`.
  - fake-claude sidecar: create with `forkSession:true` + `resumeSessionAt:<uuid>` mints a new `cliSessionId`, writes the parent's transcript prefix (uuid-verbatim, through the addressed uuid) as the child's file, and reports the new id on `sdk.session.init`.
  - Spec: `fresh-agent-rollback-rust.spec.ts`, seven tests (r2: the providers matrix gains KILROY), each ≤120s wall on the cloud backend; the spec appears in NEITHER `CLOUD_SKIP_SPECS` nor `CLOUD_SKIP_TITLES`.

- [ ] **Step 1: Write the failing behavioral test**

`test/e2e-browser/helpers/fake-claude-sdk-sidecar-control.test.ts` — append:

```ts
it('forkSession create mints a fresh cliSessionId and seeds the transcript prefix (s2rk correction)', async () => {
  // With this file's existing control rig: create ORIG, send two turns so ORIG's
  // transcript holds u1/a1/u2/a2 with uuids; then stdin-create
  // { resumeSessionId: ORIG, resumeSessionAt: <uuid of a1>, forkSession: true }.
  // Assert: the sdk.session.init wire frame carries a NEW cliSessionId !== ORIG;
  // the child transcript file contains EXACTLY the u1/a1 lines (uuid-verbatim);
  // and a follow-up plain-resume create still keeps ORIG (no same-id divergence regression).
})

it('forkSession=false resume keeps the existing same-cliSessionId behavior', async () => {
  // Control: create { resumeSessionId: ORIG } (no forkSession) -> init carries ORIG.
})
```

The new spec's declarative content (full file; helpers copied from the control spec per its own per-spec-ownership convention at :62-66, plus `WsCapture` imported from `../helpers/ws-capture`):

```ts
// test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts
// kata 1wxv — /undo + /redo conversation rollback across providers vs hermetic fakes.
// Every test hard-gates: expect(e2eServerKind).toBe('rust'); per-test RustServer ownership.

test('opencode: /undo step refills composer, /redo restores, a new submission destroys redo — and undoing a patch-carrying turn never touches files (decisions 1, 4, 5)', async ({ page }) => {
  // bootOpencodeLane with FAKE_OPENCODE_PATCH_TURN=2 (turn 2 is PATCH-CARRYING: the fake
  //   writes/modifies <cwd>/patch-target.txt while simulating it);
  // createFreshAgentPane(sessionType freshopencode); sendComposerText 'prompt one', wait for
  //   snapshot user-row 1; sendComposerText 'prompt two', wait for user-row 2.
  // const snapBefore = await fetchSnapshot(...); expect(userRows(snapBefore)).toBe(2)
  // const treeHashBefore = await sha256Tree(sessionCwd)   // every file hashed, paths sorted
  // type '/undo' + Enter via the composer textbox.
  // await expect.poll(() => userRows(await fetchSnapshot(...))).toBe(1)
  // expect(await page.getByRole('textbox', { name: 'Chat message input' }).inputValue()).toBe('prompt two')  // decision 4 refill
  // expect(await sha256Tree(sessionCwd)).toBe(treeHashBefore)  // conversation-ONLY rollback: the
  //   working tree is BYTE-IDENTICAL after undoing a patch-carrying turn (managed serve config
  //   disables opencode snapshots; native file re-application can never fire)
  // const audit = readAudit(); const reverted = audit.filter((e) => e.event === 'reverted');
  // expect(reverted).toHaveLength(1); expect(reverted[0].messageID).toMatch(/^msg/)
  // expect((await fetchSnapshot(...)).rollback).toEqual({ canRedo: true, undoneDepth: 1 })
  // expect((await fetchSnapshot(...)).rolledBackTurns).toHaveLength(2)  // msg_u2+msg_a2, all rolledBack:true
  // type '/redo' + Enter; expect.poll user rows back to 2; audit gains 'unreverted'; snapshot.rollback.canRedo === false.
  // DOUBLE undo — type '/undo' (removes turn 2), then '/undo' again (removes turn 1):
  // expect((await fetchSnapshot(...)).rolledBackTurns.filter((t) => t.role === 'user').map((t) => t.summary))
  //   .toEqual(['prompt one', 'prompt two'])  // r2: filter to user-role rows FIRST — each undone step
  //   contributes a user row AND an assistant row, so raw .map would see four summaries;
  //   user-role filter proves the two prompts are in CONVERSATION order, never wire order
  // then sendComposerText 'prompt three', wait for turn.
  // expect((await fetchSnapshot(...)).rollback.canRedo).toBe(false)      // decision 5 destroy
  // expect((await fetchSnapshot(...)).rolledBackTurns.length).toBeGreaterThan(0)  // markers survive
})

test('opencode: undo-to-here via the per-turn icon is ONE revert (decision 3)', async ({ page }) => {
  // three turns; page hover over the second user row's article[data-turn-index];
  // click role=button name 'Undo to here' inside toolbar 'Turn actions'.
  // expect.poll: 1 user row; audit has EXACTLY one 'reverted' event whose messageID
  //   equals the second user message's id (never N round trips).
})

test('codex: undo-to-here reverts in place; /redo is refused with the codex copy', async ({ page }) => {
  // bootCodexLane with FAKE_CODEX_APP_SERVER_BEHAVIOR { recordTurns: true, appendThreadOperationLogPath }.
  // two turns; click 'Undo to here' on the FIRST user turn.
  // ops = readJsonLines(logPath).filter((o) => o.method?.startsWith('thread/'));
  // expect(ops.map((o) => o.method)).toEqual(expect.arrayContaining(['thread/read', 'thread/revert']));
  // expect(ops.filter((o) => o.method === 'thread/revert')).toHaveLength(1);
  // expect(ops.find((o) => o.method === 'thread/revert').beforeTurnId).toBeTruthy();
  // expect(ops.map((o) => o.method)).not.toContain('thread/rollback');   // deprecated path never used
  // expect.poll: 0 user rows.
  // type '/redo' + Enter; await the notice banner showing
  //   'Redo is not available for Codex sessions' (pinned REDO_CODEX_UNSUPPORTED_NOTICE prefix);
  // transcript unchanged.
})

test('claude: /undo fork-at-point re-keys the pane and refills — and never touches checkpoints (decision 1)', async ({ page }) => {
  // bootClaudeLane with FRESHELL_FAKE_STDIN + FRESHELL_FAKE_EVENTS + FRESHELL_FAKE_PROGRAM seeded
  //   for two straight-through turns; createFreshAgentPane(freshclaude); two sends; captureDurableId() -> ORIG.
  // const checkpointRestores: string[] = []; page.on('request', (r) => { if (r.url().includes('/checkpoints/restore')) checkpointRestores.push(r.url()) })
  // type '/undo' + Enter.
  // await expect.poll(() => captureDurableId(...)).not.toBe(ORIG)        // re-key via materialized adoption
  // expect(composer input value).toBe('prompt two')
  // stdin log: one create with forkSession === true, resumeSessionId === ORIG, resumeSessionAt defined.
  // FRESHELL_FAKE_EVENTS wire log: sdk.session.init carries cliSessionId !== ORIG.
  // fetchSnapshot by the NEW durable id: 1 user row; rollback.canRedo === true; rolledBackTurns length 2.
  // type '/redo' + Enter; expect.poll user rows back to 2 (re-fork from ORIG observed in the stdin log).
  // expect(checkpointRestores).toEqual([])                               // rollback never touches files
})

test('kilroy: typed /undo drives the claude lane — fork-at-point fork, pane re-key, refill, marker (r2 provider coverage)', async ({ page }) => {
  // bootClaudeLane with a KILROY pane (the kilroy sessionType carries provider claude — the
  // kilroy lane reuses the SAME fake sidecar, booted with kilroy config);
  // createFreshAgentPane(sessionType kilroy); two sends; captureDurableId() -> ORIG.
  // type '/undo' + Enter.
  // await expect.poll(() => captureDurableId(...)).not.toBe(ORIG)   // adoption re-key observed
  // stdin log: one create with forkSession === true, resumeSessionId === ORIG, resumeSessionAt defined.
  // expect(composer input value).toBe('prompt two')
  // fetchSnapshot by the NEW durable id: 1 user row; rolledBackTurns length 2, all rolledBack:true.
})

test('multi-client convergence: sibling raw-WS client + REST see the same post-rollback truth (decision 10)', async ({ page }) => {
  // opencode lane; connect WsCapture (helper) BEFORE the rollback; page drives '/undo'.
  // const rolledBack = await wsCapture.waitFor((f) => f.type === 'freshAgent.event'
  //   && f.event?.type === 'freshAgent.session.rolledBack', 10_000, 'session.rolledBack');
  // expect(rolledBack.sessionId).toBe(<materialized opencode id>); expect(rolledBack.event.revokeAttention).toBe(true);
  // REST fetchSnapshot (no second page needed — the REST read IS another client's truth):
  //   1 user row, rollback.canRedo true, rolledBackTurns length 2 — identical to the driving pane's view.
  // page.reload(); pane re-attaches + re-fetches: same assertions hold (durable record survives refresh).
})

test('mid-turn lockout: /undo is rejected while a turn runs; cards survive (decisions 6, 7)', async ({ page }) => {
  // claude lane; FRESHELL_FAKE_PROGRAM rule: on msg:send emit approval (parks the turn);
  // one send; the approval card is visible; type '/undo' + Enter.
  // await the notice banner containing 'queue a message to steer it' (busy copy);
  // transcript still shows 1 user row; the approval card is STILL present (never silently
  //   resolved — cancel frames fire only on a SUCCESSFUL rollback);
  // answer the approval (its Deny/Approve button) -> turn completes; now '/undo' succeeds (sanity tail).
})
```

Registration (`test/e2e-browser/playwright.config.ts`): add `/fresh-agent-rollback-rust\.spec\.ts$/` to `RUST_ONLY_SPECS` (after the `/fresh-agent-control-rust\.spec\.ts$/` entry, with a kata comment) and to the rust-chromium `testMatch` array at the same anchor. Add NOTHING to `test/e2e-browser/playwright.cloud.config.ts`.

Fixture implementation content (complete drafts):

`test/e2e-browser/fixtures/fake-opencode.cjs` — add two arms beside the fork arm (:866) plus pointer-aware listing:

```js
if (action === 'revert' && req.method === 'POST') {
  // kata 1wxv: opencode's POST /session/:id/revert {messageID} — message-targeted.
  const body = parseJsonText(await readRequestBody(req)) || {}
  const messageId = typeof body.messageID === 'string' ? body.messageID : undefined
  const revertDb = openDatabase()
  try {
    ensureSchema(revertDb)
    if (messageId) {
      revertDb.prepare('UPDATE session SET revert = ? WHERE id = ?').run(JSON.stringify({ messageID: messageId }), sessionId)
    }
    appendAudit({ event: 'reverted', sessionId, messageID: messageId ?? null })
    sendJson(res, 200, true)
  } finally { revertDb.close() }
  return
}
if (action === 'unrevert' && req.method === 'POST') {
  const unrevertDb = openDatabase()
  try {
    ensureSchema(unrevertDb)
    unrevertDb.prepare('UPDATE session SET revert = NULL WHERE id = ?').run(sessionId)
    appendAudit({ event: 'unreverted', sessionId })
    sendJson(res, 200, true)
  } finally { unrevertDb.close() }
  return
}
```

(the exact column name mirrors the existing schema's `revert` column at :74/:113; the `session_get` route gains reading it into a TOP-LEVEL `revert` key — `session.revert = { messageID, snapshot?, diff?, partID? }`, never `info.revert`; the `GET /session/:id/message` route returns the FULL list unfiltered — the reverted tail is served unflagged exactly like the real provider (r2 cross-check: Task 3's builder filtering DEPENDS on this — the tail must never be hidden by the fake; a fake-side filter would invalidate the design); the `prompt_async` arm gains `UPDATE session SET revert = NULL ...` plus deletion of the tail message rows before its turn simulation — a new submission supersedes the tail, mirroring assumed real behavior pending LB-2.)

`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` — add the arm beside `thread/fork` (:324), reusing the file's own log/record/respond helpers verbatim:

```js
// kata 1wxv: thread/revert {threadId, beforeTurnId} — in-place prefix replacement.
// One operation-log row; recorded turns (recordTurns:true) become the prefix
// strictly BEFORE beforeTurnId; loose `{}` result (fork_thread's parse discipline).
if (method === 'thread/revert') {
  // log via the file's appendThreadOperationLogPath machinery, then:
  // record.turns = record.turns.slice(0, record.turns.findIndex(t => t?.id === beforeTurnId))
  // (findIndex -1 => unchanged), respond(id, {}), return
}
```

`test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs` — uuid chaining + fork-at-point:

```js
// appendTranscript (:130-138) gains a uuid + parentUuid chain:
const lastUuidBySession = new Map()
function appendTranscript(cliSessionId, cwd, role, text) {
  const parentUuid = lastUuidBySession.get(cliSessionId) ?? null
  const uuid = randomUUID()
  lastUuidBySession.set(cliSessionId, uuid)
  appendJsonl(transcriptPath(cliSessionId, cwd), {
    type: role, uuid, parentUuid,
    timestamp: new Date().toISOString(),
    cwd: cwd ?? process.cwd(),
    message: { role, content: [{ type: 'text', text }] },
  })
}

// create branch (:281-303): replace the cliSessionId line (:285) and transcript touch:
    const forking = msg.forkSession === true
    const cliSessionId = forking
      ? randomUUID() // s2rk correction: real claude --fork-session mints a NEW durable id
      : (msg.resumeSessionId ?? program.sessionId ?? randomUUID())
    // ...
    if (forking && msg.resumeSessionId) {
      // The child file is the parent's transcript PREFIX through resumeSessionAt
      // (uuids preserved verbatim — claude fork keeps original message ids).
      const parentPath = transcriptPath(msg.resumeSessionId, cwd)
      const parentLines = fs.existsSync(parentPath)
        ? fs.readFileSync(parentPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : []
      const cut = typeof msg.resumeSessionAt === 'string'
        ? parentLines.findIndex((l) => l.uuid === msg.resumeSessionAt)
        : parentLines.length - 1
      const prefix = parentLines.slice(0, cut < 0 ? undefined : cut + 1)
      fs.writeFileSync(transcriptPath(cliSessionId, cwd), prefix.map((l) => JSON.stringify(l)).join('\n') + (prefix.length ? '\n' : ''))
    } else {
      fs.closeSync(fs.openSync(transcriptPath(cliSessionId, cwd), 'a'))
    }
    // sdk.session.init emission below already uses cliSessionId — the wire carries the new id.
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:helpers -- fake-claude-sdk-sidecar-control && npm run test:e2e -- --project=rust-chromium fresh-agent-rollback-rust`

Expected: FAIL because the fakes don't speak revert/`thread/revert`/fork-at-point (the fake-claude helper test fails first: no uuid chain, no new id, no prefix), the production frames are still refused for all provider legs not yet landed at run order, and the spec file is not registered (no tests matched until registration).

- [ ] **Step 3: Add the minimal production (fixture + registration) implementation**

Apply the fixture diffs and registration content shown in Step 1's Interfaces/Produced notes and the complete drafts above. The spec's helper block copies ONLY what it uses from the control spec (lane boots, `createFreshAgentPane`, `sendComposerText`, `fetchSnapshot`, `captureDurableId`, audit/JSONL readers) per that file's per-spec-ownership convention; import `WsCapture` from `../helpers/ws-capture`.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:helpers && npm run test:e2e -- --project=rust-chromium fresh-agent-rollback-rust`

Expected: PASS (seven tests green on the cloud backend within the 120s per-test budget)

- [ ] **Step 5: Refactor while green**

Deduplicate any spec helper that drifted from its control-spec donor (keep behavior identical — the convention is intentional copies, but no stale copies). Audit the spec for stray `test.slow()`/timeout overrides — none allowed (cloud budget). No production-code change.

- [ ] **Step 6: Run impacted-test verification**

Fixtures are shared: the codex app-server fake serves fork/restore specs, the opencode fake serves control/fork specs, the claude fake serves control/restore walls — run every fresh-agent rust e2e suite plus the helper unit suite.

Run: `npm run test:e2e:helpers && npm run test:e2e -- --project=rust-chromium fresh-agent && npm run test:e2e -- --project=rust-chromium restore-contract-wall`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts test/e2e-browser/fixtures/fake-opencode.cjs test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs test/e2e-browser/helpers/fake-claude-sdk-sidecar-control.test.ts test/e2e-browser/playwright.config.ts test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs
git commit -m "test(fresh-agent): rust e2e for /undo + /redo across providers + fake support (kata 1wxv task 7)"
```

---

## Final acceptance gate (after Task 7; run in order)

1. `npm run test:port && npm run contract:generate && git diff --exit-code -- port/contract` — frozen contract committed and idempotent.
2. `cargo test -p freshell-protocol -p freshell-freshagent -p freshell-codex -p freshell-opencode -p freshell-ws -p freshell-server && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo clippy -p freshell-codex -p freshell-opencode --features real-transport --all-targets -- -D warnings`
3. `FRESHELL_TEST_SUMMARY="1wxv freshagent undo/redo" npm run check` — coordinated full suite (check `npm run test:status` first; wait on a foreign holder).
4. `npm run test:e2e -- --project=rust-chromium fresh-agent-rollback-rust` — the new spec green on the configured (cloud) e2e backend; confirm it is absent from `CLOUD_SKIP_SPECS`/`CLOUD_SKIP_TITLES` (`git grep -n "fresh-agent-rollback" test/e2e-browser/playwright.cloud.config.ts` returns NOTHING) and from no-filter false coverage.
5. Push the branch, then ask the user for explicit PR approval. Never `gh pr create` unprompted; never touch `main`.

## UNRESOLVED COVERAGE GAPs

None. Every kata decision maps to a task with unit coverage and (where user-visible) e2e coverage; the four provider-behavior presumptions that could shift implementation details at execution time are enumerated as Stage-2 load-bearing validations with the exact fallback each implies (LB-1..LB-5), not left as plan gaps.
