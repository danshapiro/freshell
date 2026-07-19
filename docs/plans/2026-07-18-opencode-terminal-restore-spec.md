# OpenCode Terminal-Pane Durable Session Restore — Implementer Spec

**Date:** 2026-07-18
**Branch context:** `feat/rust-tauri-port` @ `f53196a4`
**Scope:** Bring **opencode TERMINAL panes** (`mode === 'opencode'` PTY running the real
`opencode` CLI) to durable-restore parity with codex and amplifier terminal panes.
**Sibling precedent:** `docs/plans/2026-07-18-amplifier-restore-spec.md` (#514 port).
**Status of this doc:** read-only investigation complete; this is the build spec. No code
has been written.

---

## 0. Executive Summary

- **Legacy has NO opencode terminal↔session association.** This work is **BEYOND legacy**,
  designed by analogy to the amplifier-locator precedent (#514, `05c6b1fa`).
- opencode 1.18.3 persists sessions in a **single SQLite DB** (`<data_home>/opencode.db`,
  WAL mode) — NOT one dir/file per session. The `storage/` tree holds only diffs/reminders.
- The correlation substrate therefore differs structurally from amplifier's (dir-appearance
  + `events.jsonl` probe): opencode detection is a **SQLite row-diff** over the `session`
  table, keyed on `id` (`ses_…`), confirmed by `directory` (cwd) and `time_created` (ms).
- **Recommended design: (b) a sibling `opencode_locator.rs` module** (+ `opencode_association.rs`
  WS controller), NOT (a) a provider-parameterized locator. The two providers share only the
  thin correlation-window bookkeeping; their detection primitives share zero code, and the
  opencode variant is strictly *simpler* (the row already carries cwd/parent/marker inline,
  so there is no async probe-retry state machine). Premature generalization fails the
  two-implementation rule.
- **Resume syntax:** `opencode --session <id>` (manifest `resumeArgs: ["--session","{{sessionId}}"]`,
  already wired through `cli_launch.rs`). Restore already respawns correctly once a
  `resumeSessionId` exists — the ONLY gap is producing that id via association.
- **Client is already ready** — `isDurableProviderSessionId('opencode', id) => /^ses_/.test(id)`,
  generic `reconcileTerminalSessionAssociation`, generic reopen. No client changes needed.
- **Estimated size:** ~800–1000 lines net (locator ~400 incl. tests, WS controller ~250 incl.
  tests, a bounded `list_sessions_since` query ~40, wiring ~30, one rust-gated e2e ~150).
  Medium slice, lower risk than #514 (no probe FSM to port).

---

## 1. Context & Current State

Three restore mechanisms exist in the port today:

| Provider (terminal pane) | Mechanism | Where |
| --- | --- | --- |
| codex | CLIENT-side durable-id capture (`codexDurability` via display-id secret) | `src/…` (client) |
| amplifier | SERVER-side locator: watch provider home for new session dir, correlate with first-Enter window, broadcast `terminal.session.associated` | `crates/freshell-sessions/src/amplifier_locator.rs`, `crates/freshell-ws/src/amplifier_association.rs` |
| **opencode** | **NONE (this spec)** | — |

freshopencode **CHAT** panes (`kind: 'fresh-agent'`, the `opencode serve` sidecar) already
have durable thread ids and are out of scope. This spec is exclusively about opencode
**TERMINAL** panes.

The generic client→persist→restart→resume chain is provider-agnostic and already in place:
- `src/lib/terminal-session-association.ts:62` `reconcileTerminalSessionAssociation` — persists
  any `sessionRef` on `terminal.session.associated`; only codex is special-cased (additive).
- `shared/session-flavor.ts:65` `isDurableProviderSessionId` — `opencode` arm is
  `/^ses_/.test(sessionId)` (line 70–72), matching the DB id format.
- `shared/session-contract.ts:4` `SessionRef.provider` is `z.string().min(1)` — generic.
- `src/lib/session-flavor-reopen.ts` — opencode restores via the generic arm (lines 53–66),
  gated by `isDurableProviderSessionId`.
- `src/lib/session-utils.ts:113` `buildResumeContent` — explicit `codex || opencode` arm.

**Restore respawn already works** once a `resumeSessionId` is attached:
`crates/freshell-platform/src/cli_launch.rs:443` applies `spec.resume_args`
(`["--session","{{sessionId}}"]` from `extensions/opencode/freshell.json`) →
`opencode --session <id>`. Golden test asserts this shape at
`crates/freshell-platform/src/cli_launch_goldens.rs:69`.

**The single missing piece:** nothing gives an opencode terminal pane its `resumeSessionId`.
This spec adds the server-side locator + association broadcast that does.

---

## 2. Legacy Status (server/ frozen + origin/main) — BEYOND-LEGACY, flagged

Verified from BOTH the frozen worktree `server/` (Jul 4) AND `origin/main`:

1. **No opencode terminal locator exists anywhere.**
   - Frozen `server/coding-cli/` has NO `amplifier-session-locator.ts` at all (predates #514).
   - `origin/main`'s `server/coding-cli/amplifier-session-locator.ts` is **amplifier-ONLY**:
     guard `record.mode !== 'amplifier'` (main `:298`), watches `<amplifierHome>/projects`
     (`:237`). It is not provider-generic.
2. `origin/main`'s opencode server modules — `opencode-session-controller.ts`,
   `opencode-activity-tracker.ts`, `opencode-activity-wiring.ts`, `opencode-ownership-reducer.ts`,
   `opencode-activity-integration.ts` — drive the **freshopencode CHAT sidecar** (`opencode serve`).
   `opencode-session-controller.ts` binds via the activity tracker's `association.requested`
   events (sidecar HTTP session events), `bindSession(terminalId, 'opencode', …)` — NOT PTY
   correlation. Terminal PTYs running the `opencode` CLI directly do not feed that tracker.
3. `server/coding-cli/providers/opencode.ts` provides:
   - `getResumeArgs(sessionId) => ['--session', sessionId]` (frozen `:362`, main `:364`)
   - `supportsSessionResume() => true` (frozen `:374`, main `:376`)
   - **No locator / no terminal association.**

**Conclusion:** "parity with codex and amplifier" for opencode terminals means implementing a
capability that does not exist in legacy. Design follows the amplifier-locator precedent, not a
port of existing behavior.

---

## 3. OpenCode On-Disk Session Model (verified on host, READ-ONLY)

Host: `opencode` 1.18.3, `~/.local/share/opencode/opencode.db` (4.6 GB, WAL mode). Verified via
read-only `sqlite3` inspection and `opencode --help`.

### 3.1 Storage layout
- **Primary store: SQLite** `<data_home>/opencode.db` (+ `-wal`, `-shm`). One DB, all sessions
  as rows. The `storage/` dir contains only `session_diff/`, `agent-usage-reminder/`,
  `directory-readme/` — **no session records**. Older per-file JSON layouts are gone in 1.18.x.
- `data_home` resolution (port already implements, `parse/opencode.rs:308`
  `default_opencode_data_home`): `$XDG_DATA_HOME/opencode` → win `LOCALAPPDATA/opencode` →
  `~/.local/share/opencode`.

### 3.2 `session` table (verified schema)
```
id            text PRIMARY KEY   -- "ses_<base62>", e.g. ses_08865bf29ffeLRN2Bsf6E2ePon
project_id    text NOT NULL
parent_id     text               -- NON-NULL => subagent/child/fork  (REJECT)
slug          text NOT NULL
directory     text NOT NULL      -- cwd (confirmation key)
title         text NOT NULL
version       text NOT NULL
time_created  integer NOT NULL   -- ms epoch (13 digits, e.g. 1784418025686)
time_updated  integer NOT NULL
time_archived integer            -- NON-NULL => archived (REJECT)
agent, model, workspace_id, path, metadata, cost, tokens_* …
```
`project` table: `id`, `worktree` (project path), `time_created`, …

Session id format matches client gate `/^ses_/`. `parent_id` non-null is the direct analog of
amplifier's `parent_id`/`session:fork` subagent marker; the sampled child rows are all
`@general subagent` sessions with a set `parent_id`.

### 3.3 Resume CLI syntax (verified `opencode --help`)
- `-s, --session <id>` — resume/continue a specific session id.  ← **the resume flag**
- `-c, --continue` — continue the last session.
- `--fork` — fork when continuing (do NOT use for restore; forking creates a child).
- Manifest already correct: `extensions/opencode/freshell.json`
  `cli.resumeArgs = ["--session", "{{sessionId}}"]`. No manifest change needed.

### 3.4 Port's existing read path (reuse this)
`crates/freshell-sessions/src/parse/opencode.rs` — 1:1 port of legacy
`opencode-listing-query.ts` + `OpencodeProvider.listSessionsDirect`. Read-only `rusqlite`
(`OpenFlags::SQLITE_OPEN_READ_ONLY`), `busy_timeout(5000ms)`. Key facts the locator depends on:
- `run_opencode_listing_query` (`:103`) filters **root sessions only**:
  `WHERE s.time_archived IS NULL {AND s.parent_id IS NULL}` (`:169-170`), ordered
  `time_updated DESC`.
- Maps `id`→`session_id`, `directory`→`cwd`, `p.worktree`→`project_path`,
  `time_created`→`created_at`, `time_updated`→`last_activity_at` (`:158-172`).
- Computes the **3-views marker** (`THREE_VIEWS_MARKER_SQL_PATTERN`,
  `"%<freshell-session-metadata origin=3-views%"`, `:18`): sessions freshell ITSELF spawned
  for the 3-views/orchestration flow. `list_sessions` flags them `is_subagent/is_non_interactive`
  (`:289-298`) but still returns them.
- Degradation classes preserved: `MissingDb`, `EmptyDb`, `SchemaMissingParentId`, plus the
  transient `OpencodeReadError` re-throw (preserve-cached contract).

---

## 4. Correlation Feasibility & Design

### 4.1 Why the amplifier pattern does NOT transfer literally
The amplifier locator watches for a **new directory** appearing under
`<amplifier_home>/projects/<slug>/sessions/<id>/` and then bounded-reads its `events.jsonl`
(`amplifier_locator.rs:343` `snapshot_session_dirs`, `:601` `probe_events_file`). **opencode
creates no new file or directory per session** — a new session is an `INSERT` into the SQLite
`session` table, materialized (in WAL mode) by appending to `opencode.db-wal` with the base
`opencode.db` mtime often unchanged until checkpoint (the "WAL wrinkle" already documented at
`crates/freshell-sessions/src/directory_index.rs:487-489`).

Therefore opencode detection must be a **row-diff**: snapshot the set of known root session ids
before the terminal's first Enter, then poll for a **new** id whose `directory` matches the pane
cwd and whose `time_created` lands in the correlation window.

### 4.2 What replaces `events.jsonl`
Nothing separate is needed. The `session` row **already carries** everything the amplifier probe
had to read out of `events.jsonl`:

| amplifier (probe `events.jsonl`) | opencode (read the row) |
| --- | --- |
| `session:start` first-record existence | row exists in `session` |
| `parent_id != null` / `session:fork` → subagent | `parent_id IS NOT NULL` → reject |
| underscore-named dir → subagent | (n/a) |
| `session:config.working_dir` → cwd confirm | `directory` column → cwd confirm |
| session id = dir name | `id` column |
| appeared_at = poll-observed time | `time_created` (authoritative ms) |

Consequence: the opencode locator has **no `Pending`/`NotReady` probe-retry FSM** — a candidate
is confirmed or rejected **synchronously at admit time** from its row fields. This is a genuine
simplification vs `amplifier_locator.rs` (which must tolerate `events.jsonl`/`session:config`
landing late, `:424-430`).

### 4.3 Reject rules (candidate is NEVER eligible if any hold)
1. `parent_id IS NOT NULL` — subagent/fork/child.
2. `time_archived IS NOT NULL` — archived.
3. 3-views marker present (`has_three_views_marker == 1`) — freshell's own non-interactive
   spawn. (NOTE: `list_sessions` currently *includes but flags* these; the locator must
   *exclude* them as candidates.)
4. `directory` (normalized) ≠ pane cwd (normalized) — foreign cwd.
5. `time_created` outside the correlation window (see §4.4).
6. Ambiguity: **≥2** surviving candidates in one window → **refuse + log, bind none** (mirror
   `amplifier_locator.rs:529-537`).

### 4.4 Correlation window — the one design subtlety (OPEN QUESTION, must verify)
Amplifier creates its session dir **lazily at first prompt submit**, so it anchors the window at
Enter: `[Enter − PRE_EPSILON_MS(250), Enter + WINDOW_MS(2000)]` (`amplifier_locator.rs:77,82`).

**opencode's TUI may create the session row at process START, before the first Enter.** This is
NOT yet verified (verifying it requires launching a real interactive `opencode`, which writes to
the user's live 4.6 GB DB — out of scope for a read-only investigation). The design MUST be
robust to both cases:

- **Arm at CREATE (spawn):** snapshot known root session ids AND record `arm_ms = now`.
- **Window lower bound = `arm_ms − PRE_EPSILON_MS`**, NOT `Enter − PRE_EPSILON_MS`. This admits a
  row created anywhere between spawn and Enter (covers "row at TUI start") while still excluding
  every pre-arm session (excluded by the id snapshot regardless).
- **Window upper bound = `first_submit_ms + WINDOW_MS`** if an Enter was seen, else
  `arm_ms + SPAWN_WINDOW_MS` (a spawn-anchored fallback, propose `WINDOW_MS` reused = 2000, or a
  slightly larger `OPENCODE_SPAWN_WINDOW_MS`). Rationale: if opencode creates the row at spawn,
  the association can resolve without ever waiting for Enter; if it creates lazily at first
  prompt (like amplifier), the Enter-anchored bound still applies.
- The **id-diff snapshot at arm is the primary safety**, exactly as in amplifier
  (`armed.snapshot`, `:130-132`): any id already present at arm can never bind, independent of
  timing. `time_created` bounds are a secondary foreign-session guard.

**Implementer action:** confirm opencode's row-creation timing with a single manual probe (launch
`opencode`, note whether a `session` row appears before the first prompt) OR encode BOTH shapes in
the e2e fake-CLI fixture (§7) and keep the spawn-anchored fallback. Do not ship a purely
Enter-anchored window until row-at-start is disproven.

### 4.5 Ambiguity / collision risks
- Two opencode panes launched in the **same cwd** whose rows both land in one window → §4.3(6)
  refuse. Acceptable (rare; user re-associates by continuing to type — a later distinct id may
  still resolve on a subsequent Enter window, matching amplifier's "keep watching" for
  zero-candidate, `amplifier_locator.rs:859`).
- WAL read latency: a just-inserted row may not be visible to a freshly-opened read-only
  connection until the WAL frame is committed. Mitigation: the poll retries each sweep; the
  window is 2 s wide; `busy_timeout` already set. Open a fresh read-only connection per tick
  (matches `list_sessions`).
- DB size (4.6 GB) → do NOT run the full `list_sessions` query each tick. Add a **bounded**
  `list_sessions_since(floor_ms)` (see §5, Slice A) filtering `time_created >= floor` with a
  `LIMIT`, where `floor = min(arm_ms over armed terminals) − PRE_EPSILON_MS`. Only scans while
  armed (idle short-circuit, §4.6).

### 4.6 Idle short-circuit (carry over from amplifier)
`tick()` performs **zero** DB I/O whenever zero terminals are armed
(`amplifier_locator.rs:315-326`). Re-baseline the known-id snapshot on the idle→armed transition
(`arm`'s fresh read, `:249-271`). Same structure here — a fresh `list_sessions_since` at arm time.

---

## 5. Implementation Slices

Mirror the #514 two-slice split (`amplifier_locator.rs` = correlation core;
`amplifier_association.rs` = WS controller + wiring).

### Slice A — `crates/freshell-sessions/src/opencode_locator.rs` (correlation core)
New module, exported from `crates/freshell-sessions/src/lib.rs` (alongside
`pub mod amplifier_locator;`). Public API mirrors `AmplifierLocator` so the WS controller is a
near-copy:

```rust
pub struct OpencodeLocator { /* data_home, window/epsilon config, Mutex<Inner>, scan counter */ }

pub struct Located { pub terminal_id: String, pub session_id: String, pub cwd: String }

impl OpencodeLocator {
    pub fn new(data_home: PathBuf) -> Self;                    // watches <data_home>/opencode.db
    pub fn with_config(data_home: PathBuf, window_ms: i64, pre_epsilon_ms: i64) -> Self;
    pub fn arm(&self, terminal_id, mode, running, resume_session_id, cwd, now_ms) -> bool; // mode=="opencode"
    pub fn disarm(&self, terminal_id: &str);
    pub fn note_submit(&self, terminal_id: &str, at_ms: i64) -> bool;
    pub fn tick(&self, now_ms: i64) -> Vec<Located>;          // DB row-diff + resolve
    pub fn armed_count(&self) -> usize;                       // test hook
    pub fn db_scan_count(&self) -> u64;                       // test hook (idle short-circuit proof)
}
```
Internals differ from amplifier only in the detection primitive:
- Replace `snapshot_session_dirs()` (`fs::read_dir` walk) with a **bounded root-session id +
  fields read** from `opencode.db` via a new `OpencodeProvider::list_sessions_since(floor_ms, now_ms)`
  (add to `parse/opencode.rs`, reusing `run_opencode_listing_query` with an extra
  `AND s.time_created >= ?` and `LIMIT`). Returns `(session_id, cwd, parent_id_is_null,
  time_created, has_three_views_marker)` per root row.
- Candidate admit = synchronous confirm/reject from row fields (§4.2/§4.3) — **no `Pending`
  probe FSM, no `probe_events_file`**.
- Keep `armed` map, per-terminal id-snapshot, `note_submit` window, `resolve_windows` ambiguity
  refuse, prune, and idle short-circuit — structurally identical to `amplifier_locator.rs`.
- Constants: reuse `PRE_EPSILON_MS = 250`, `WINDOW_MS = 2000`; add spawn-anchored
  `OPENCODE_SPAWN_WINDOW_MS` per §4.4 (propose 2000, tune after the row-timing probe).
- `normalize_cwd` — reuse the lexical+canonicalize approach (`amplifier_locator.rs:567`).
- All entry points take explicit `now_ms` (deterministic tests, no real sleeps).

### Slice B — `crates/freshell-ws/src/opencode_association.rs` (WS controller + wiring)
Near-copy of `amplifier_association.rs`:
- `is_submit_input` — reuse (identical Enter-only rule); consider hoisting to a shared spot or
  duplicating (one-liner, duplication acceptable).
- `maybe_arm(state, terminal_id, mode, cwd, resume_session_id)` — guard `mode == "opencode"`,
  `state.opencode_locator`.
- `note_possible_submit(state, terminal_id, data)` — submit-shaped → `locator.note_submit`.
- `drain_and_associate(state)` — `spawn_blocking(locator.tick)`, then for each `Located`:
  re-validate against `state.registry.directory()` (mode `opencode`, running, not already bound),
  `state.identity.upsert(.., Some("opencode"), Some(session_id), cwd, ..)`,
  `state.registry.set_meta(.., Some("opencode"), Some(session_id))`, and broadcast (below).
- `broadcast_terminal_session_associated` — emit `ServerMessage::TerminalSessionAssociated` with
  `SessionLocator { provider: "opencode", session_id }` AND the paired `TerminalMetaUpdated`
  upsert (`provider: "opencode"`), exactly as `amplifier_association.rs:165-201`.
- `spawn_opencode_locator_sweep(state, interval)` — `tokio::time::interval` loop.

### Slice C — wiring (mechanical)
- `crates/freshell-ws/src/lib.rs:181` — add `pub opencode_locator: Option<Arc<…OpencodeLocator>>;`
  to `WsState` (mirror `amplifier_locator`); set `None` in the two test constructors
  (`terminal.rs:1834,2033`) and the default at `lib.rs:583`.
- `crates/freshell-ws/src/terminal.rs:468` — add a sibling
  `crate::opencode_association::note_possible_submit(state, &input.terminal_id, &input.data);`
  next to the amplifier one.
- `crates/freshell-ws/src/terminal.rs:1004` — add a sibling
  `crate::opencode_association::maybe_arm(state, &terminal_id, &mode, resolved_cwd.as_deref(),
  resume_session_id.as_deref());` next to the amplifier one.
- `crates/freshell-server/src/main.rs:299` — construct
  `opencode_locator = Some(Arc::new(OpencodeLocator::new(default_opencode_data_home())))`
  (data_home from `freshell_sessions::parse::opencode::default_opencode_data_home()`); assign at
  `:306`; add the sweep at `:447` guarded by `opencode_locator.is_some()` with an
  `OPENCODE_LOCATOR_SWEEP_INTERVAL` (reuse the amplifier cadence).

### Slice D — client
**None.** Verified ready (§1). Do not touch client code. If a regression appears, it is a wiring
bug in B/C, not a client gap.

---

## 6. NOT-to-Build Fences

- **Do NOT** touch freshopencode CHAT/sidecar code (`opencode-*` in `server/`, the
  `FreshOpencodeState`, `crates/freshell-opencode/*`). Chat panes already have durable ids.
- **Do NOT** modify the client (`src/`, `shared/`) — the generic association path already
  handles `opencode`. In particular do not add an opencode arm to
  `reconcileTerminalSessionAssociation` or `session-flavor-reopen.ts`; the generic arm suffices.
- **Do NOT** change `extensions/opencode/freshell.json` resumeArgs or `cli_launch.rs` — resume
  respawn already produces `opencode --session <id>`.
- **Do NOT** write to `opencode.db` from freshell (read-only `rusqlite` only; preserve the
  `OpencodeReadError` preserve-cached contract).
- **Do NOT** build the provider-parameterized locator (option a) — see §8.
- **Do NOT** add a live filesystem/DB watcher (chokidar/notify); poll under the armed-only
  short-circuit, matching #514's documented rationale (`amplifier_locator.rs:26-38`).
- **Do NOT** use `--fork` in any resume path (creates a child session, breaks identity).
- **Do NOT** correlate 3-views-marked or `parent_id`-bearing sessions (§4.3).

---

## 7. Test List

Crate tests mirror the amplifier locator suite (`amplifier_locator.rs:673-1046`), adapted to
SQLite fixtures (write rows into a temp `opencode.db` via `rusqlite`, or a minimal seeded schema).

**`opencode_locator.rs` unit tests (deterministic `now_ms`):**
1. Fresh root row (cwd == pane cwd, `time_created` in window) → exactly one `Located`.
2. Row `parent_id IS NOT NULL` → never a candidate.
3. Row `time_archived IS NOT NULL` → never a candidate.
4. Row with 3-views marker → never a candidate.
5. Row cwd ≠ pane cwd → never a candidate.
6. Row `time_created` before `arm_ms − PRE_EPSILON` (foreign/pre-existing) → not matched.
7. Two confirmed candidates in one window (same cwd) → refuse + log, bind none.
8. Zero candidates (empty Enter) → keep watching, do not disarm.
9. Resume/bound terminal (`resume_session_id.is_some()`) → never arms.
10. Non-opencode mode / not-running → never arms.
11. `disarm` stops correlation entirely.
12. Idle short-circuit: `tick()` while unarmed performs zero DB scans (`db_scan_count` baseline).
13. Row created while idle never binds to a terminal that arms afterward; a row created after arm
    still resolves (arm-time re-baseline, §4.6).
14. **Row-created-at-spawn (before any Enter)** resolves via the spawn-anchored window (§4.4).
15. **Row-created-lazily-at-first-Enter** resolves via the Enter-anchored window (§4.4).
16. Missing DB / empty DB → tolerated, no panic, no bind (mirror `tolerates_missing_projects_dir`).

**`opencode_association.rs` tests (mirror `amplifier_association.rs:292-448`):**
17. `is_submit_input` Enter-only recognition (reuse the existing cases).
18. `maybe_arm` ignores non-opencode modes; arms a fresh opencode terminal; skips a resuming one.
19. `note_possible_submit` ignores non-Enter input.
20. `drain_and_associate` binds identity + broadcasts `terminal.session.associated` AND
    `terminal.meta.updated` (provider `opencode`, the located `ses_…` id) on a real seeded DB row.

**Rust-gated e2e (one, per the mandate):**
21. Fake `opencode` CLI fixture: a small script/binary that, on launch, writes a **real
    session-row shape** into a temp `opencode.db` (root row: `ses_…` id, `directory = cwd`,
    `parent_id NULL`, `time_created = now`), covering BOTH timing shapes (row-at-spawn and
    row-at-first-Enter — §4.4). Drive: create terminal (`mode=opencode`) → arm → submit → sweep →
    assert a `terminal.session.associated` with the fixture's `ses_…` id → simulate restart →
    assert the restore create resolves argv **`opencode --session <ses_…>`** (assert through
    `cli_launch` resume-arg application, cf. golden `cli_launch_goldens.rs:69`).

---

## 8. Generalization Decision — Recommend (b), sibling module

**Weighed:** (a) generalize `amplifier_locator` into a provider-parameterized locator
(watch-path + candidate-probe + reject-rules per provider) with amplifier + opencode backends,
vs (b) a sibling `opencode_locator.rs`.

**Recommendation: (b), a sibling module.**

Rationale (ruthless-simplicity + KERNEL two-implementation rule):
- The two providers' **detection substrates share zero code**: amplifier walks a directory tree
  and bounded-reads JSONL (`std::fs` + `probe_events_file`); opencode diffs a SQLite table
  (`rusqlite`). A parameterized `Locator<Backend>` would have to straddle "watch a dir tree +
  async probe with retry" and "query a DB table synchronously" — an abstraction whose only honest
  shared surface is the ~150-line correlation-window bookkeeping.
- The opencode variant is **strictly simpler** (no `Pending`/`NotReady` probe FSM, §4.2), so it
  is not a parallel copy of amplifier — it is a leaner cousin. Forcing it through amplifier's
  generalized shape would *add* complexity (retry states it doesn't need) rather than remove it.
- Only two implementations exist. Extracting a shared abstraction now is premature per the
  two-implementation rule; the shared window/refuse/prune logic is small and the amplifier version
  is battle-tested. If a **third** provider ever needs locator-style correlation, that is the
  trigger to extract a `CorrelationWindows` helper (armed map + `note_submit` window +
  ambiguity-refuse + prune + idle short-circuit) that both call — the natural seam is already
  visible (the state machine in `resolve_windows`/`prune_discoveries`).

**Deferred-extraction seam (document, don't build):** the provider-agnostic pieces are the
`armed`/`window`/prune/idle-short-circuit bookkeeping; the provider-specific pieces are
`snapshot()` (dir-walk vs DB-diff) and candidate confirmation (JSONL probe vs row fields). A
future `trait LocatorBackend { fn snapshot_candidates(now) -> Vec<Candidate>; }` with the window
state machine generic over it is the clean extraction — but only once a real third consumer
justifies it.

---

## 9. File:line Anchor Index

**Port (worktree `feat/rust-tauri-port`):**
- `crates/freshell-sessions/src/amplifier_locator.rs` — correlation-core precedent (arm `:225`,
  note_submit `:292`, tick `:313`, snapshot `:343`, probe `:601`, resolve `:454`, ambiguity `:529`).
- `crates/freshell-sessions/src/parse/opencode.rs` — read path (query `:103`, root filter
  `:123-127,169-170`, row map `:158-192`, `list_sessions` `:247`, marker `:18`, data_home `:308`).
- `crates/freshell-sessions/src/directory_index.rs:449-538` — `OpencodeSource`, WAL wrinkle note
  `:487-489`.
- `crates/freshell-ws/src/amplifier_association.rs` — WS controller precedent (maybe_arm `:43`,
  note_possible_submit `:62`, drain `:86`, broadcast `:165`, sweep `:207`).
- `crates/freshell-ws/src/lib.rs:181,583` — `WsState.amplifier_locator`.
- `crates/freshell-ws/src/terminal.rs:468` (note_possible_submit call), `:1004` (maybe_arm call),
  `:733-764` (resume-id derivation), `:862` (`resolve_coding_cli_command`).
- `crates/freshell-server/src/main.rs:299-306` (locator construction), `:447-450` (sweep wiring).
- `crates/freshell-platform/src/cli_launch.rs:434-497` (resume-arg application, `:443` `spec.resume_args`).
- `crates/freshell-platform/src/cli_launch_goldens.rs:69` (opencode `["--session","{{sessionId}}"]` golden).
- `extensions/opencode/freshell.json` — `resumeArgs` manifest.
- `src/lib/terminal-session-association.ts:62` (generic reconcile), `src/lib/session-flavor-reopen.ts:34-66`,
  `src/lib/session-utils.ts:113`, `shared/session-flavor.ts:65-72` (`isDurableProviderSessionId`),
  `shared/session-contract.ts:4` (`SessionRef.provider`).

**Legacy:**
- Frozen `server/coding-cli/providers/opencode.ts:362` (`getResumeArgs`), `:374` (`supportsSessionResume`).
- `origin/main:server/coding-cli/amplifier-session-locator.ts:298` (amplifier-only guard), `:237`
  (watches `<amplifierHome>/projects`).
- `origin/main:server/coding-cli/opencode-session-controller.ts` (sidecar bind, NOT terminal PTY).
- `origin/main` commits: `05c6b1fa` (#514 amplifier durable), `5c56ecc3` (#516 bounded resume).
