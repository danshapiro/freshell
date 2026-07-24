# Fix Spec: Amplifier Terminal Panes Must Restore Across Server Restart (Rust Port)

- **Status:** Ready for implementation (read-only investigation complete)
- **Author:** rust-dev code-intel investigation, 2026-07-18
- **Port branch:** `feat/rust-tauri-port` @ `a77828bd`
- **Reference (main):** `5c56ecc3` (HEAD), fix built on `05c6b1fa` = "feat(amplifier): durable session tracking via events.jsonl (#514)"
- **Bug:** On the Rust port, an amplifier terminal pane that was running when the server restarts comes back as a **blank new amplifier session** (no `resume`), losing the conversation. Bit the user in production.

---

## Executive Summary (10 lines)

1. **What #514 does:** Adds a server-side `AmplifierSessionLocator` that watches `~/.amplifier/projects`, correlates a running amplifier PTY's **first Enter/submit** with the **new session dir** that appears (confirmed via the dir's `events.jsonl` `session:start` + `session:config` cwd), then binds the terminal to that session id via `registry.bindSession(...,'amplifier',...)` and broadcasts `terminal.session.associated`. Amplifier's provider gains `getResumeArgs → ['resume', <id>]` + `supportsSessionResume → true`.
2. **How restore then works (all pre-existing, provider-generic):** broadcast → client `reconcileTerminalSessionAssociation` writes `sessionRef`/`resumeSessionId` onto the pane → persisted to localStorage → on restart `TerminalView` re-drives `terminal.create` with the resume id → server builds `amplifier resume <id>`. #514 states "WS protocol and client code untouched."
3. **What the port lacks:** The Rust server has **no live PTY↔session association for any provider** (`identity.rs` is explicit: "no `associateSession`/late `terminal.session.bound` wiring"). It never emits `terminal.session.associated`, so the client never captures an amplifier `sessionRef` → nothing to persist → blank respawn.
4. **What the port ALREADY has:** amplifier is a valid mode (`CodingCliProviderSchema = z.string().min(1)`, open); the wire contract already carries `terminal.session.associated` + `terminal.meta.updated` + open-provider `SessionLocator`; `amplifier resume <id>` construction is already plumbed (`extensions/amplifier/freshell.json` + `cli_launch` golden G-A2); the client restore machinery (#516 already cherry-picked) is provider-generic.
5. **Minimal fix shape:** Port #514's **locator + association-broadcast** to the Rust server only. One new server→client emission (`terminal.session.associated` + a `terminal.meta.updated` upsert carrying the sessionRef) for amplifier PTYs.
6. **Client changes needed: NO (best case).** The frozen client's generic reconcile + restore already handle amplifier once the server broadcasts. Prove with an e2e; add client code ONLY if the e2e shows a real gap.
7. **Shared/ changes needed: NO.** All required wire types already exist in the frozen `shared/` and its Rust mirror (`freshell-protocol`). No `shared/` deviation; side-by-side wire-compat preserved.
8. **CLI resume syntax verified on host:** `amplifier resume [SESSION_ID]` (partial id allowed) — matches the manifest template `["resume","{{sessionId}}"]`.
9. **Disambiguation (two amplifier sessions, same cwd):** #514 does NOT disambiguate on cwd alone — it uses **Enter-press temporal correlation** (which terminal's `[Enter−250ms, Enter+2000ms]` window the new dir fell into) + cwd confirmation. Two candidates in one window → **refuse + log** (never mis-bind); zero → keep watching.
10. **Estimated size:** ~1 new Rust module (~400–600 LOC, direct port of `amplifier-session-locator.ts`'s core) + a controller/broadcast hook (~60 LOC) + a terminal-input "submit" seam in the WS path + crate tests + 1 Playwright scenario with a fake-amplifier CLI fixture. **Server-only. Medium.** No client, no shared, no wire changes.

---

## 1. Context & Root Cause

### 1.1 The restore chain (main, working)

Amplifier's REPL creates its session dir **lazily at the first prompt submit**, not at spawn. So the identity of a running amplifier PTY is unknown at create time. #514 closes that gap server-side, and the rest of the chain is provider-generic and already existed:

```
[server] amplifier PTY spawns (fresh, no session id)
   │  user types first prompt + Enter
[server] AmplifierSessionLocator: Enter ↔ new ~/.amplifier/projects/.../sessions/<id>/ dir
   │        confirmed via <dir>/events.jsonl session:start + session:config(working_dir)
[server] registry.bindSession(terminalId,'amplifier',<id>,'association')
[server] broadcast terminal.session.associated { terminalId, sessionRef:{provider:'amplifier',sessionId:<id>} }
[client] reconcileTerminalSessionAssociation → pane.sessionRef + resumeSessionId set
[client] persistMiddleware → localStorage
   ── SERVER RESTART ──
[client] TerminalView restore → terminal.create { mode:'amplifier', resumeSessionId:<id>, restore:true }
[server] resolve_coding_cli_command → args ["resume", <id>] → `amplifier resume <id>`
```

### 1.2 Where the port breaks

The Rust port implements **every link except the first two** (locator + broadcast). Without the association broadcast, `pane.sessionRef`/`resumeSessionId` are never set, nothing is persisted, and restore re-drives a **fresh** `amplifier` launch.

Root-cause anchors (port):
- `crates/freshell-ws/src/identity.rs:1-22` — module doc: *"NOT a full port of `TerminalMetadataService` (no ... `associateSession`/late `terminal.session.bound` wiring)"*.
- `crates/freshell-server/src/session_directory.rs:685-687` — *"a created `codex` terminal with no session id yet (identity established only at ... which this port doesn't associate — see `crate::identity`'s module doc)"*.
- No emit site for `ServerMessage::TerminalSessionAssociated` exists in `crates/` (only the type at `crates/freshell-protocol/src/server_messages.rs:109-110,874`). Only `TerminalMetaUpdated` is emitted (`crates/freshell-ws/src/terminal.rs:1097`).
- `crates/freshell-sessions/src/amplifier.rs` indexes `metadata.json` post-hoc (sidebar discovery) but performs **no live association** of a running PTY.

---

## 2. Reference Enumeration (#514 @ `05c6b1fa`, repo `/home/dan/code/freshell`)

### 2.1 Server files (the mechanism to mirror)
| File | LOC | Role |
|------|-----|------|
| `server/coding-cli/amplifier-session-locator.ts` | 746 | **Core.** Enter↔dir correlation, cwd confirmation, single-candidate resolution. |
| `server/coding-cli/amplifier-session-controller.ts` | 123 | Subscribes locator `session.located` → `registry.bindSession(...,'amplifier',...,'association')` → emits `associated`. |
| `server/coding-cli/providers/amplifier.ts` | +14 (in-file) | `getResumeArgs(id)→['resume',id]`, `supportsSessionResume()→true`, `getLiveEventsPath()`, `homeDir=~/.amplifier`. |
| `server/coding-cli/provider.ts` | +4 | Adds optional `getLiveEventsPath?()` capability. |
| `server/index.ts` | +75 | Wires locator+controller; `controller.on('associated') → broadcastTerminalSessionAssociation({provider:'amplifier',source:'amplifier_locator'})`; widens claude `onNewSession` fast-path to amplifier (metadata.json safety-net). |
| `server/session-association-broadcast.ts` | +9 | Adds sources `amplifier_locator`, `amplifier_new_session`. |
| `server/session-observability.ts` | +5 | `AssociationBroadcastSource` type wiring. |

Also in #514 but **out of scope for restore** (turn/activity signalling — busy/green): `amplifier-events-tailer.ts`, `amplifier-events-reducer.ts`, `amplifier-activity-integration.ts`, `turn-completion-ledger.ts`, `*-activity-*` trackers/wiring. The restore fix does **not** require these; do not port them here.

### 2.2 Locator mechanism (exact anchors, `amplifier-session-locator.ts`)
- Registry event subscriptions — `:246-249`: `terminal.created` (arm), `terminal.input.raw` (detect submit/Enter), `terminal.session.bound`, `terminal.exit`.
- Arming rule — `:299-302`: **only fresh amplifier panes arm.** Resume terminals (bound at create / awaiting named-resume) never arm; `record.cwd` required.
- Constants — `:66-83`: `AMPLIFIER_DIR_APPEAR_WINDOW_MS = 2000`, `AMPLIFIER_DIR_PRE_EPSILON_MS = 250`; correlation window `[Enter−250ms, Enter+2000ms]`.
- Watcher — `:367-386`: watch `~/.amplifier/projects` at **fixed depth** (never an ancestor — inotify-exhaustion / $HOME-escape guard); tolerate lazily-created `projects/`.
- Fresh-session probe — `:547-561`: first `events.jsonl` line must be `session:start`; reject `parent_id`/`session:fork` (subagent). Underscore-named dirs = sub-sessions, never candidates (`:466`).
- cwd confirmation — `:29, :577-584`: confirm via `session:config` record `working_dir`/`project_dir`; `realpath` normalize (`:165-177`).
- Resolution at window close — `:31-35, :620-690`: exactly one cwd-confirmed candidate → emit `session.located`; **multiple → refuse + log**; zero → keep watching.
- Controller bind+emit — `amplifier-session-controller.ts:111,117`: `registry.bindSession(terminalId,'amplifier',sessionId,'association')` then `emit('associated',{terminalId,sessionId,eventsPath})`.

### 2.3 shared/ contract changes in #514
**None affecting the wire.** `getLiveEventsPath` is a TS server-internal interface method, not a wire type. `terminal.session.associated` already existed pre-#514.

### 2.4 src/ client changes in #514
**None** — "WS protocol and client code untouched." Confirms the client path is provider-generic.

### 2.5 Tests / fixtures in #514 (fixture pattern to mirror for our e2e)
- `test/server/amplifier-session-association.test.ts` (304)
- `test/server/coding-cli/amplifier-session-locator.test.ts` (565)
- Fixture events logs — `test/fixtures/coding-cli/amplifier/events/*.jsonl` + `README.md`: `normal-turn.jsonl`, `resume-append.jsonl`, `steering-injection.jsonl`, `kill9-orphan.jsonl`, `pty-hangup-completes.jsonl`, `continue-attach-orphan-end.jsonl`, `tool-turn-out-of-order-end.jsonl`. These are **hand-authored `events.jsonl` streams** fed to the tailer/locator — the pattern our fake-amplifier CLI fixture should emit (a `session:start` + `session:config{working_dir}` under a new `projects/<slug>/sessions/<id>/` dir on first Enter).

---

## 3. Port Current State (branch `feat/rust-tauri-port` @ `a77828bd`)

### 3.1 Frozen client (`src/` @ `737cb008` + 3 deviations)
Deviation files (all from `cd35c24c` "cherry-pick #516 bounded resume, breadcrumb, re-anchor" + icons):
- `src/components/TerminalView.tsx` (+57), `src/components/fresh-agent/FreshAgentView.tsx` (+80), `src/components/icons/provider-icons.tsx` (+27).

Capabilities already present (no changes needed for restore):
- amplifier is a valid mode — `src/store/types.ts:28` `TabMode = 'shell' | CodingCliProviderName`; `shared/ws-protocol.ts:43` `CodingCliProviderSchema = z.string().min(1)` (open string; `provider:'amplifier'` is wire-valid).
- Wire contract carries associations — `shared/ws-protocol.ts:87` `terminal.meta.updated`, `:694` `terminal.session.associated { sessionRef: SessionLocator }`, `:47` `SessionLocatorSchema` (open provider).
- Incoming-association handler is generic — `src/lib/terminal-session-association.ts:62 reconcileTerminalSessionAssociation`: persists `sessionRef`/`resumeSessionId` onto pane/tab; only codex has special-cases; **does not gate on `isDurableProviderSessionId`**.
- Restore is generic for coding-CLI modes — `src/components/TerminalView.tsx:~4083` `isCodingCliMode = restoreMode !== 'shell'`; `:~4162` tab-`sessionRef` fallback; re-drives `terminal.create` with `contentRef.current?.resumeSessionId` (`:~4220`).
- `isDurableProviderSessionId` (`shared/session-flavor.ts:65`) **omits amplifier**, BUT it is **NOT on the restore path**. It is used only by:
  - `src/lib/session-flavor-reopen.ts` — the CLI↔fresh-agent *swap* feature (`resolveReopenPaneSessionTarget` requires `getPairedSessionTypeTarget`; amplifier has no fresh-agent pairing, so it returns null regardless — out of scope), and
  - `src/components/fresh-agent/FreshAgentView.tsx:289`.
  Neither governs terminal restore. **No client change required for restore.** (See §7 for the reopen caveat.)

### 3.2 Rust server
- amplifier CLI launch is plumbed:
  - `extensions/amplifier/freshell.json` — runtime manifest (so `state.cli_commands` contains `amplifier`; required by the mode-known gate at `crates/freshell-ws/src/terminal.rs:697`).
  - `crates/freshell-platform/src/cli_launch_goldens.rs:709-724` (G-A2): manifest `resume_args = ["resume","{{sessionId}}"]` → `["resume","sess-123"]`.
  - `crates/freshell-ws/src/terminal.rs:744-753` — resume-id derivation is **generic** for non-shell/non-codex modes: `requested_ref.session_id || create.resume_session_id`. So `create{mode:'amplifier', resumeSessionId:<id>}` already yields `amplifier resume <id>`.
- Terminal identity registry exists but is capture-only from client-supplied create data:
  - `crates/freshell-ws/src/identity.rs` `TerminalIdentityRegistry::{upsert,retire,get,list,find_by_session}` — mirrors `TerminalMetadataService`'s association slice, **minus** `associateSession`.
  - `crates/freshell-terminal/src/registry.rs:222-273` — `TerminalSession.mode` + `resume_session_id`; `set_meta` (`:924-957`) accepts mode + resume id; directory `session_ref` derived in the router (`:266`).
- **Missing:** any watcher of `~/.amplifier/projects` bound to a live PTY; any emit of `terminal.session.associated`.

### 3.3 Frozen-base amplifier support
`shared/` has **zero** amplifier references; `src/` references amplifier only in `provider-icons.tsx`. Confirmed: the frozen base carried **no amplifier-specific association/restore code** — as expected, since #514 landed after `737cb008` and touched only the server.

---

## 4. The Gap + Minimal Fix

### 4.1 Decision table
| Concern | Reference (main) | Port today | Fix |
|--------|------------------|-----------|-----|
| Running amplifier PTY → session id | `AmplifierSessionLocator` | **absent** | **Port locator to Rust (server-only).** |
| Bind terminal to session | `registry.bindSession(...,'amplifier',...)` | absent | New controller hook → `TerminalIdentityRegistry::upsert(provider='amplifier', session_id)`. |
| Tell client the identity | broadcast `terminal.session.associated` (+ meta upsert) | **never emitted** | **Emit `TerminalSessionAssociated` + `TerminalMetaUpdated` upsert** for amplifier. (One new emission.) |
| Client captures/persists sessionRef | generic reconcile + persist | present, generic | **No change.** |
| Restart respawn `amplifier resume <id>` | generic create + resume args | present (`terminal.rs:744-753`, manifest) | **No change.** |
| Sidebar reopen of amplifier session | resume via create path | see §7 | **No change for restore;** reopen tracked separately. |
| Wire/shared types | pre-existing | pre-existing | **No shared/ change.** |

### 4.2 Implementation slices (ordered)

**Slice A — Amplifier session locator (server, the bulk).** New Rust module (suggest `crates/freshell-ws/src/amplifier_locator.rs` or a `freshell-sessions` submodule co-located with `amplifier.rs`). Direct port of `amplifier-session-locator.ts` core:
- Arm on terminal create for `mode == "amplifier"` **fresh** panes only (skip resume/bound); capture `{terminal_id, cwd (realpath-normalized), armed_at}`.
- Observe terminal **submit/Enter** to open a correlation window `[t−250ms, t+2000ms]`.
- Watch `~/.amplifier/projects` at fixed depth for new `sessions/<id>/` dirs; probe `<dir>/events.jsonl`: require `session:start`, reject `parent_id`/`session:fork`/underscore dirs (subagent), confirm cwd from `session:config.working_dir`/`project_dir`.
- Resolve at window close: exactly one cwd-confirmed candidate → produce `Located{terminal_id, session_id, events_path}`; multiple → refuse + `warn`; zero → keep watching.
- **Enter/submit seam (implementer note):** the TS locator consumes `registry.on('terminal.input.raw', ...)` with an `isSubmitInput` (Enter) test. The Rust `TerminalRegistry` does **not** currently emit an input event; the `terminal.input` WS handler in `crates/freshell-ws/src/terminal.rs` writes straight to the PTY. Add a minimal hook there (or a registry callback) that notifies the locator of a submit-shaped input (`\r`/`\n`) for an armed amplifier terminal. Keep it to armed terminals to avoid overhead. This is the one genuinely new seam beyond a straight port.
- **Amplifier home:** `AMPLIFIER_HOME` env else `~/.amplifier` (mirror `defaultAmplifierHome()` and the port's `session_directory.rs` home-resolution style; **use the real user home, honor the env override**).

**Slice B — Association controller + broadcast (server, small).**
- On `Located`: `TerminalIdentityRegistry::upsert(terminal_id, Some("amplifier"), Some(&session_id), Some(&cwd), now)` and set the terminal's `resume_session_id`/`session_ref` via the registry `set_meta` path so the directory/meta reflect it.
- Emit `ServerMessage::TerminalSessionAssociated { terminal_id, session_ref: SessionLocator{provider:"amplifier", session_id} }` to the pane's clients, plus a `TerminalMetaUpdated` upsert carrying the sessionRef (mirror the existing `terminal.rs:1097` meta-emit shape so the client's `reconcileTerminalSessionAssociation` + meta reducer both see it).
- Idempotency: bind once per terminal; ignore repeat locates (mirror controller's single-bind).

**Slice C — Client.** **None planned.** After Slices A+B, run the e2e (§6). Only if it shows the pane's `sessionRef`/`resumeSessionId` not persisting or not replaying should client code be touched — and then the minimal change, documented as a new `src/` deviation. Do **not** pre-emptively edit the frozen client.

**Shared/:** **None.** If, and only if, the e2e reveals the client silently drops an amplifier association at a durability gate on the restore path (not expected — reconcile is ungated), escalate as a `shared/` deviation **decision** (adding amplifier to `isDurableProviderSessionId`), because `shared/` is frozen and wire-compat with the TS server matters for side-by-side. Adjudicate with the user before any `shared/` edit.

---

## 5. Test List

### 5.1 Rust crate tests (mirror #514's locator/association suites)
- **Locator unit** (port of `amplifier-session-locator.test.ts`), using a temp `~/.amplifier` and synthetic `events.jsonl`:
  - fresh `session:start` + `session:config{working_dir==pty cwd}` inside the Enter window → one `Located`.
  - dir appears **before** `Enter−250ms` (foreign session) → not matched.
  - `parent_id`/`session:fork`/underscore dir (subagent) → rejected.
  - **two** cwd-confirmed candidates in one window → refuse + log, **no bind** (the same-cwd disambiguation guard, §risks).
  - zero candidates (empty Enter) → keep watching, no bind.
  - resume/bound terminal → never arms.
  - watcher points only at `projects/` (no ancestor escape); tolerates lazily-created `projects/`.
- **Association/emit** (port of `amplifier-session-association.test.ts`): on `Located` → identity registry upserts provider/sessionId, and exactly one `TerminalSessionAssociated` (+ meta upsert) is emitted with `provider:"amplifier"`.
- **CLI resume already covered:** `cli_launch_goldens.rs` G-A2 (no new test needed; reference it).

### 5.2 Playwright e2e (one matrix scenario) — **requires a fake amplifier CLI fixture**
Because live association depends on the CLI writing `events.jsonl` on first Enter, the e2e needs a **fake `amplifier` binary** (script) that, on first submit, `mkdir -p $AMPLIFIER_HOME/projects/<slug>/sessions/<id>/` and appends `session:start` then `session:config{working_dir:$PWD}` to `<id>/events.jsonl` (mirror #514's fixture event shapes). Point the manifest/`AMPLIFIER_CMD` (+ `AMPLIFIER_HOME`) at the fixture.

Scenario **"amplifier pane restores across server restart"**:
1. Open an amplifier pane; type a prompt + Enter (fixture creates the session dir + events).
2. Assert the pane receives `terminal.session.associated` and the client shows a durable identity (persisted `sessionRef`/`resumeSessionId`).
3. Restart the server (test-harness restart, not the self-hosted process).
4. Assert the pane restores by spawning `amplifier resume <id>` (assert the spawned argv / a fixture-emitted "resumed <id>" marker), **not** a blank session.
5. Negative: a pane that never submitted → restores fresh (no false bind).

---

## 6. Verification (evidence requirements before "done")
- `cargo test -p <locator-crate>` green, including the two-same-cwd **refuse** case and the foreign-dir **no-match** case.
- Playwright restore scenario green; captured evidence shows `amplifier resume <id>` on restart (argv or fixture marker), and the negative case shows fresh restore.
- `rust_check` clean on new files; no `todo!()`/`unwrap()` in the locator's non-test code.
- Confirm **zero** diffs to `shared/` and (unless escalated) to `src/`.

---

## 7. Risks & Edge Cases
- **Same-cwd ambiguity (two amplifier sessions in one dir):** disambiguated by **Enter-window temporal correlation**, not cwd. If two confirmed dirs land in one terminal's window → **refuse + log** (never mis-bind); the coordinator/metadata safety-net (`onNewSession`, if ported) can still bind later when `metadata.json` lands. Mirror #514 exactly; do not "pick the newest."
- **Enter-seam correctness:** over-broad input hooking (every keystroke) would churn; scope submit detection to **armed amplifier terminals** and Enter-shaped input only.
- **Watcher scope:** never watch an ancestor of `projects/` (inotify exhaustion / `$HOME` escape) — fixed-depth watch on `projects/` only.
- **Lazy `projects/`:** cold-start before `~/.amplifier/projects` exists — tolerate a missing path and pick it up when created (chokidar-equivalent behavior).
- **Metadata-less dirs:** a dir with only `events.jsonl` (killed before first `prompt:complete`) never gains `metadata.json` and is **not** resumable — locator still associates for the live session, but discovery/index intentionally skips it (matches provider policy).
- **Realpath/case/trailing-slash cwd mismatches:** normalize both sides (`realpath` + lexical) before comparing, per `:160-177`.
- **Self-hosted restart caution:** per repo rules, do **not** restart the self-hosted Freshell server to test; use an isolated port / test harness.

---

## 8. NOT-To-Build Fences
- **Do NOT** port #514's activity/turn pipeline (tailer/reducer/activity-integration/turn-completion-ledger). Busy/green signalling is a separate feature; restore does not need it.
- **Do NOT** edit `shared/` or its Rust mirror wire types — the contract already suffices. Any perceived need is a **decision to escalate**, not to implement.
- **Do NOT** edit the frozen `src/` client unless the e2e proves a concrete restore-path gap; if so, minimal + recorded as a deviation.
- **Do NOT** add amplifier to `isDurableProviderSessionId` for restore — it is off the restore path (it governs only the CLI↔fresh-agent reopen swap, which amplifier doesn't participate in). Revisit only as a separate "sidebar reopen of amplifier" enhancement, if desired.
- **Do NOT** disambiguate same-cwd candidates by heuristic guessing — refuse and log, as the reference does.
- **Do NOT** restart the self-hosted server as part of testing.
```

Reference commit for the fix: **`05c6b1fa`** (main), hardened by `5c56ecc3` (#516, already cherry-picked into the port's frozen client).
