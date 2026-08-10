# Sweep Deferrals Closure + Platform Test Deflake Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Close the four ledgered deferrals from the naming-persistence sweep
(A1 fresh-agent REST tab registration, A2/A3 dead-code removal, A4
ai-title-shadow-cleanup migration port) and deflake the pre-existing
`freshell-platform` live-netsh test so `cargo test -p freshell-platform` is
deterministic.

**Architecture:** All Rust work mirrors existing Node reference behavior
(`server/` is frozen — read-only oracle). A1 mirrors the already-correct
`create_content_tab` registration pattern into the fresh-agent create path.
A4 ports Node's one-time boot migration into a new `migrations` module with
marker I/O on `SettingsStore`, plus the Node read-model guard
(`applyOverride`'s provider-generated suppression, Task 5b) the Rust port
was missing — validation proved the cleanup is not durable without it. B converts the one panicking live-interop test
to an explicit env-gated opt-in and backfills the hermetic coverage it was
informally providing.

**Tech Stack:** Rust (axum, tokio, serde_json; workspace crates
`freshell-freshagent`, `freshell-server`, `freshell-platform`), TypeScript
(Redux Toolkit, Vitest).

## Global Constraints

Copied from the task spec + `port/AGENTS.md` (binding for every task):

- **Worktree:** all work happens in `/home/dan/code/freshell/.worktrees/sweep-deferrals-deflake` (branch based on `origin/feat/rust-tauri-port` @ `d8199cf0f`). Every command below assumes this as cwd unless it gives an absolute path.
- **Delivery:** merge back to `feat/rust-tauri-port` and push that branch to origin. **DO NOT open a PR. NEVER push `main`.**
- **Purity invariant:** `git diff --name-only origin/feat/rust-tauri-port -- server/ shared/` MUST be empty at delivery. `server/` and `shared/ws-protocol.ts` are frozen; Node code is a read-only reference.
- **Port equivalence:** behavior-equivalent to Node except objectively defective behavior; intentional divergences require a `port/oracle/DEVIATIONS.md` entry with an objective defect criterion + pinning test (adjudicated by an antagonist reviewer, never self-approved). None are expected in this plan.
- **TDD:** red-green-refactor for every non-trivial change.
- **Structural limits:** ≤10K LOC/crate, ≤1K lines/file. New logic goes in NEW modules; the only exception is ~85 lines of marker/flush I/O added to `settings_store.rs` because `home`, `persist`, and `ConfigLock` are private to it (justified in Task 4).
- **Process safety:** NEVER touch the user's live freshell server on port 3001; never broad-kill; test servers bind unique high ports and only kill PIDs they spawned. No test in this plan spawns a server.
- **Vitest:** focused runs via `npm run test:vitest -- run <file>` (NEVER raw `npx vitest`). Broad TS runs (`npm run check`) are coordinator-gated — wait for the holder, never kill a foreign run.
- **Commits:** conventional, focused, atomic (`feat:`/`fix:`/`test:`/`refactor:`/`docs:`).
- **Checklist honesty:** update `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md` evidence only for what is actually proven; never force-check items with unmet sub-criteria.

## File Structure

| File | Task | Action | Responsibility |
|---|---|---|---|
| `crates/freshell-freshagent/src/lib.rs` | 1, 2 | Modify | `TabRecord` struct (reduce), fresh-agent `create_tab` (register in LayoutStore) |
| `crates/freshell-freshagent/src/terminal_tabs.rs` | 1 | Modify | Drop `kind` param + dead field writes |
| `crates/freshell-freshagent/src/pane_ops.rs` | 1 | Modify | Fix stale doc comment |
| `crates/freshell-freshagent/src/pane_ops_tab_tests.rs` | 1, 2 | Modify | Fix stale comment; new A1 tests |
| `src/store/paneTitleSync.ts` | 3 | **Delete** | Caller-less thunk |
| `test/unit/client/store/tab-pane-title-sync.test.ts` | 3 | Modify | Dispatch reducer action directly |
| `test/e2e/title-sync-flow.test.tsx` | 3 | Modify | Dispatch reducer action directly |
| `crates/freshell-server/src/migrations.rs` | 4, 5 | **Create** | Pure cleanup helper + migration orchestration + all A4 tests |
| `crates/freshell-server/src/settings_store.rs` | 4 | Modify | `is_migration_done` / `mark_migration_done` / `flush_to_disk` |
| `crates/freshell-server/src/main.rs` | 4, 5 | Modify | `mod migrations;` + boot wiring |
| `crates/freshell-server/src/session_directory.rs` | 5b | Modify | Provider-generated read-guard in `apply_session_overrides` (+ `title_source` plumbing) |
| `crates/freshell-server/src/auto_title_sweep.rs` | 5b | Modify | Same guard on the sweep's session-title overlay (canonical-push input) |
| `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md` | 5, 5b | Modify | SESSION-04 evidence text |
| `crates/freshell-platform/src/port_forward.rs` | 6 | Modify | Tests module only: hermetic fakes + env-gated live test |
| `port/machine/specs/platform-glue.md` | 6 | Modify | P19 row: note the opt-in live leg |

Task order matters: Task 1 (A2) runs before Task 2 (A1) so the A1 code
inserts the already-reduced `TabRecord { title }` shape.

---

### Task 1: A2 — Remove write-only `TabRecord.pane_id` / `TabRecord.kind`

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs:127-129` (tabs-field doc comment)
- Modify: `crates/freshell-freshagent/src/lib.rs:273-280` (`TabRecord`)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs:276-283` (drop `kind` param)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs:294-301` and `:1071-1078` (insert literals)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs:231` and `:251` (call sites drop the positional arg)
- Modify: `crates/freshell-freshagent/src/pane_ops.rs:425-427` (stale doc comment)
- Modify: `crates/freshell-freshagent/src/pane_ops_tab_tests.rs:378` (stale test comment)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `pub(crate) struct TabRecord { pub(crate) title: Option<String> }`
  (in `crates/freshell-freshagent/src/lib.rs`) and
  `fn create_content_tab(state: &FreshAgentState, name: Option<String>, pane_content: Value, restore_key: Option<&str>, broadcast: bool) -> Response`
  (the `kind: &str` parameter is GONE). Task 2 constructs `TabRecord { title: ... }`.

Background (verified by prior recon, compiler-proven): rustc emits
`crates/freshell-freshagent/src/lib.rs:278:16: warning: fields 'pane_id' and 'kind' are never read`
on `cargo check -p freshell-freshagent` (and `--tests`). `TabRecord` derives
only `Clone` — no serde, never serialized to HTTP/WS/disk, so removal is
wire- and disk-format-neutral. `GET /api/tabs` reads the LayoutStore
(AUTO-03), not this map. The sole plumbing that dies with the fields is
`create_content_tab`'s `kind: &str` parameter (only use: the struct literal)
and its two literal call-site args `"browser"` / `"editor"`. The
`pane_content` JSON's own `"kind"` keys are real wire data and MUST stay.

Explicitly OUT of scope (flag in the commit message, do not do):
`TabRecord.title` is also production-write-only (only a test reads it);
collapsing the whole `tabs` map to a `HashSet` is a strictly larger change —
leave it.

- [ ] **Step 1: Capture the RED signal (the dead-code warning)**

```bash
cd /home/dan/code/freshell/.worktrees/sweep-deferrals-deflake
cargo check -p freshell-freshagent --message-format short 2>&1 | grep "never read"
```

Expected output (this IS the red state):
```
crates/freshell-freshagent/src/lib.rs:278:16: warning: fields `pane_id` and `kind` are never read
```

- [ ] **Step 2: Reduce `TabRecord` and fix its stale doc comments**

In `crates/freshell-freshagent/src/lib.rs`, replace the struct at `:273-280`:

```rust
/// Legacy per-tab shadow record. NOT the `GET /api/tabs` row -- that reads
/// the shared LayoutStore (AUTO-03). Load-bearing only for `pane_ops`:
/// `rename_tab` mirrors the title here, and `delete_tab` gates its legacy
/// shadow-map cleanup on this record's presence.
#[derive(Clone)]
pub(crate) struct TabRecord {
    pub(crate) title: Option<String>,
}
```

And replace the `tabs` field doc comment at `:127-128` (the field itself is
unchanged):

```rust
    /// tabId -> legacy shadow record. `GET /api/tabs` reads the LayoutStore
    /// (AUTO-03), not this map; it remains only as `delete_tab`'s cleanup
    /// gate and `rename_tab`'s title mirror.
    pub(crate) tabs: Arc<Mutex<HashMap<String, TabRecord>>>,
```

- [ ] **Step 3: Remove the dead writes and the dead `kind` parameter**

In `crates/freshell-freshagent/src/terminal_tabs.rs`:

(a) `create_content_tab` signature (`:276-283`) — delete the `kind: &str`
parameter:

```rust
fn create_content_tab(
    state: &FreshAgentState,
    name: Option<String>,
    pane_content: Value,
    restore_key: Option<&str>,
    broadcast: bool,
) -> Response {
```

(b) Its `TabRecord` insert (`:294-301` area) becomes:

```rust
    state.tabs.lock().expect("tabs mutex").insert(
        tab_id.clone(),
        TabRecord {
            title: name.clone(),
        },
    );
```

(c) The two call sites (`:231` browser branch, `:251` editor branch): delete
the `"browser"` / `"editor"` positional argument. Do NOT touch the
`"kind": "browser"` / `"kind": "editor"` keys inside the `pane_content`
JSON — those go over the wire in `ui.command{tab.create}`.

(d) `create_terminal_tab`'s insert (`:1071-1078` area) becomes:

```rust
    state.tabs.lock().expect("tabs mutex").insert(
        tab_id.clone(),
        TabRecord {
            title: name.clone(),
        },
    );
```

(its inline `"terminal".to_string()` kind value disappears with the field).

- [ ] **Step 4: Fix the two remaining stale comments**

In `crates/freshell-freshagent/src/pane_ops.rs:425-427`, the doc comment
claims "split/close/respawn continuity and restore still read it" — no such
read exists (the map is `pub(crate)`; `freshell-server` cannot read it).
Replace that sentence with:

```rust
    /// The legacy `TabRecord.title` shadow is kept updated too (nothing
    /// reads it in production today; `pane_ops_tab_tests` pins the mirror).
```

In `crates/freshell-freshagent/src/pane_ops_tab_tests.rs:378`, adjust the
test comment making the same false claim to say the mirror is pinned for
consistency, not because production reads it.

- [ ] **Step 5: Verify GREEN — warning gone, crate tests pass**

```bash
cargo check -p freshell-freshagent --message-format short 2>&1 | grep -c "never read" || true
cargo check -p freshell-freshagent --tests --message-format short 2>&1 | grep -c "never read" || true
cargo test -p freshell-freshagent
```

Expected: both grep counts `0`; test run: all existing tests PASS (no test
asserts on `pane_id`/`kind`, so none should need edits — if one fails,
inspect before changing it).

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-freshagent/src/pane_ops.rs crates/freshell-freshagent/src/pane_ops_tab_tests.rs
git commit -m "refactor(freshagent): drop write-only TabRecord.pane_id/kind + dead kind plumbing

Compiler-proven dead (rustc dead_code warning, whole-crate analysis over a
pub(crate) map). TabRecord has no serde surface, so no wire/disk change.
Also corrects the stale doc comments claiming GET /api/tabs and
continuity/restore read this map (retired by AUTO-03).

Flagged, not done: TabRecord.title is also production-write-only; collapsing
the map to a HashSet is a larger follow-up."
```

---

### Task 2: A1 — Register fresh-agent REST-created tabs in the LayoutStore

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs:1362-1459` (`create_tab`, fresh-agent branch)
- Test: `crates/freshell-freshagent/src/pane_ops_tab_tests.rs` (new section at end of file)

**Interfaces:**
- Consumes: `TabRecord { title: Option<String> }` (Task 1);
  `LayoutStore::create_tab(&self, title: Option<&str>) -> (String, String)`,
  `LayoutStore::attach_pane_content(&self, tab_id: &str, pane_id: &str, content: Value) -> RenameOutcome`
  (existing, `layout_store.rs:303` / `:529`); test helpers
  `state_with_registry`, `app`, `post`, `get`, `patch`, `delete` from
  `pane_ops_tests.rs` (already re-exported into `pane_ops_tab_tests.rs`).
- Produces: behavioral only — `POST /api/tabs {"agent":"opencode"}` now
  registers tab+pane in `state.layout`, `state.tabs`, and the responses/
  broadcasts carry store-minted ids. No new named interfaces.

Background: Node's fresh-agent REST create allocates ids via
`layoutStore.createTab({title: name})` (`server/agent-api/router.ts:701`)
and attaches the pane content (`:592` area). Rust's `create_tab`
(`lib.rs:1362`) instead mints its own `Uuid::new_v4()` ids and never touches
`state.layout`, so the tab is invisible to `GET /api/tabs`/`GET /api/panes`
and `PATCH /api/panes/:id` answers `200 {message:"pane not found"}`. The
`LayoutStore` has NO register-existing-id API — the store must mint the ids
(exactly like Node). Node's rollback (`closeTab` on runtime-create failure)
has no Rust analogue on purpose: the Rust opencode create is a placeholder
(no runtime call at create time; cold start is deferred to send-keys), so
nothing between `create_tab` and the response can fail — do NOT add an
unreachable rollback branch.

- [ ] **Step 1: Write the failing tests**

Append to `crates/freshell-freshagent/src/pane_ops_tab_tests.rs` (reuse the
file's existing imports; add any missing ones like `delete` to the
`use super::tests::{...}` line):

```rust
// ── POST /api/tabs {"agent":"opencode"} registers in the store (A1) ────────

#[tokio::test]
async fn fresh_agent_rest_create_registers_tab_and_pane_in_the_layout_store() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (status, body) = post(
        router.clone(),
        "/api/tabs",
        json!({ "agent": "opencode", "name": "My Agent" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let tab_id = body["data"]["tabId"].as_str().unwrap().to_string();
    let pane_id = body["data"]["paneId"].as_str().unwrap().to_string();

    // The store carries the tab under the SAME ids the route returned
    // (Node mints {tabId,paneId} via layoutStore.createTab, router.ts:701).
    let (rows, active) = state.layout.list_tabs();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["id"], json!(tab_id));
    assert_eq!(rows[0]["title"], json!("My Agent"));
    assert_eq!(rows[0]["activePaneId"], json!(pane_id));
    assert_eq!(active.as_deref(), Some(tab_id.as_str()));

    // GET /api/panes: fresh-agent kind, derived "OpenCode" title
    // (layout_store_content.rs:51), and NO terminalId key (absent = omitted).
    let (status, body) = get(router.clone(), "/api/panes", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let panes = body["data"]["panes"].as_array().unwrap();
    assert_eq!(panes.len(), 1, "{panes:?}");
    assert_eq!(panes[0]["id"], json!(pane_id));
    assert_eq!(panes[0]["kind"], json!("fresh-agent"));
    assert_eq!(panes[0]["title"], json!("OpenCode"));
    assert!(panes[0].get("terminalId").is_none(), "{:?}", panes[0]);

    // GET /api/tabs over HTTP agrees with the store read.
    let (status, body) = get(router, "/api/tabs", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["activeTabId"], json!(tab_id));
    assert_eq!(body["data"]["tabs"][0]["id"], json!(tab_id));
}

#[tokio::test]
async fn fresh_agent_rest_created_pane_renames_via_patch() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (status, body) = post(
        router.clone(),
        "/api/tabs",
        json!({ "agent": "opencode" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let tab_id = body["data"]["tabId"].as_str().unwrap().to_string();
    let pane_id = body["data"]["paneId"].as_str().unwrap().to_string();

    let (status, body) = patch(
        router,
        &format!("/api/panes/{pane_id}"),
        json!({ "name": "Renamed Agent" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Pre-fix this is {message:"pane not found"}; post-fix it is the real
    // rename result (router.ts:1420 shape), tabRenamed because single-pane.
    assert_eq!(body["data"]["tabId"], json!(tab_id), "{body}");
    assert_eq!(body["data"]["paneId"], json!(pane_id));
    assert_eq!(body["data"]["tabRenamed"], json!(true));

    let rows = state.layout.list_panes(Some(&tab_id)).expect("tab in store");
    assert_eq!(rows[0].title.as_deref(), Some("Renamed Agent"));
}

#[tokio::test]
async fn delete_fresh_agent_tab_cleans_legacy_shadow_maps() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (status, body) = post(
        router.clone(),
        "/api/tabs",
        json!({ "agent": "opencode" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let tab_id = body["data"]["tabId"].as_str().unwrap().to_string();
    let pane_id = body["data"]["paneId"].as_str().unwrap().to_string();

    let (status, body) = delete(router, &format!("/api/tabs/{tab_id}"), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // delete_tab's legacy shadow cleanup is gated on
    // state.tabs.remove(..).is_some() (pane_ops.rs:485-491): without A1's
    // TabRecord registration the pane_tabs entry leaks.
    assert!(!state.tabs.lock().unwrap().contains_key(&tab_id));
    assert!(!state.pane_tabs.lock().unwrap().contains_key(&pane_id));
}
```

Notes for the implementer:
- These use the shared helpers in `pane_ops_tests.rs:13-117`; `oneshot`
  consumes the `Router`, hence `router.clone()` per request.
- `PATCH /api/panes/:id` calls
  `rename_persistence::persist_syncable_terminal_rename` with the pane
  snapshot. `state_with_registry()` installs no persistence hook and the
  existing `lib.rs mod rename_pane_tests` PATCH tests run against plain
  state, so expect a no-op for a fresh-agent pane; if it does require a
  hook, mirror the `RecordingPersistence` setup from
  `rename_cascade_tests.rs` instead of weakening assertions.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cargo test -p freshell-freshagent fresh_agent_rest -- --nocapture
cargo test -p freshell-freshagent delete_fresh_agent_tab_cleans_legacy_shadow_maps
```

Expected: FAIL — first test at `rows.len() == 1` (store has 0 tabs); rename
test at `body["data"]["tabId"]` (body carries `message: "pane not found"`);
delete test either at the DELETE status (tab unknown) or at the `pane_tabs`
assertion (entry leaked).

- [ ] **Step 3: Implement — mirror `create_content_tab`'s registration**

In `crates/freshell-freshagent/src/lib.rs` `create_tab` (the fresh-agent
branch, currently `:1374-1459`): replace everything from the two
`Uuid::new_v4()` id mints down to the final `ok_json` with:

```rust
    // A1 (naming-sweep ledger deferral): the shared LayoutStore mints
    // {tabId, paneId} -- Node does the same for fresh-agent tabs
    // (`layoutStore.createTab`, router.ts:701) -- so REST/MCP-created
    // fresh-agent tabs are visible to GET /api/tabs + GET /api/panes and
    // renamable via PATCH /api/panes/:id, exactly like the
    // terminal/browser/editor paths (`terminal_tabs::create_content_tab`).
    let (tab_id, pane_id) = state.layout.create_tab(name.as_deref());
    // `makePlaceholderSessionId(requestId)` = `freshopencode-<requestId>` (adapter.ts:75).
    let request_id = Uuid::new_v4().simple().to_string();
    let placeholder = format!("freshopencode-{request_id}");

    // The `paneContent` the original attaches + echoes in the ui.command payload.
    let mut pane_content = json!({
        "kind": "fresh-agent",
        "sessionType": SESSION_TYPE,
        "provider": PROVIDER,
        "sessionId": placeholder,
        "createRequestId": request_id,
        "status": "connected",
    });
    if let Some(cwd) = &cwd {
        pane_content["initialCwd"] = json!(cwd);
    }
    if let Some(model) = &model {
        pane_content["model"] = json!(model);
    }
    if let Some(effort) = &effort {
        pane_content["effort"] = json!(effort);
    }

    state
        .layout
        .attach_pane_content(&tab_id, &pane_id, pane_content.clone());
    state.tabs.lock().expect("tabs mutex").insert(
        tab_id.clone(),
        TabRecord {
            title: name.clone(),
        },
    );
    state.panes.lock().expect("panes mutex").insert(
        pane_id.clone(),
        PaneEntry {
            placeholder_id: placeholder.clone(),
            cwd,
            model,
            effort,
            durable_id: None,
        },
    );
    // Every pane-minting path records its owning tab in the shared
    // `pane_tabs` reverse index so `pane_ops`'s split/close/select handlers
    // can resolve this pane's tab.
    state
        .pane_tabs
        .lock()
        .expect("pane_tabs mutex")
        .insert(pane_id.clone(), tab_id.clone());

    // Broadcast AFTER registration -- Node's order is createTab -> runtime
    // create -> attachPaneContent -> broadcast -> respond (router.ts:546-589),
    // and `create_content_tab` likewise inserts before broadcasting.
    // Shape note (validated): Node OMITS the `title` key when no name was
    // provided (JSON.stringify drops undefined, router.ts:704). Serialize
    // the same shape instead of `"title": null` -- the shared client
    // tolerates both (`payload.title ||`, tabsSlice.ts:306), but keep the
    // broadcast Node-shaped. If an existing test pins a null-title
    // broadcast, update it to this shape.
    let mut create_payload = json!({
        "id": tab_id,
        "paneId": pane_id,
        "paneContent": pane_content,
    });
    if let Some(name) = &name {
        create_payload["title"] = json!(name);
    }
    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "tab.create".to_string(),
        payload: Some(create_payload),
    }));

    ok_json(
        json!({ "tabId": tab_id, "paneId": pane_id, "sessionId": placeholder }),
        "fresh-agent pane created",
    )
}
```

This REPLACES the old comment block at `lib.rs:1443-1448` that documented
the gap ("the fresh-agent path never touches `state.tabs` ... an
intentional, separately-scoped gap") — that comment must not survive. Keep
the `name`/`cwd`/`model`/`effort` parsing above this block unchanged.

- [ ] **Step 4: Run the new tests to verify they pass, then the crate suite**

```bash
cargo test -p freshell-freshagent fresh_agent_rest
cargo test -p freshell-freshagent delete_fresh_agent_tab_cleans_legacy_shadow_maps
cargo test -p freshell-freshagent
```

Expected: 3 new tests PASS; full crate suite PASS (in particular
`split_agent_pane_is_honest_400` and the existing `rename_pane_tests` must
stay green — `send_keys`/`capture` look panes up in `state.panes` by pane
id, and the store-minted id is what now lands there, so they are unaffected).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/pane_ops_tab_tests.rs
git commit -m "feat(freshagent): register fresh-agent REST-created tabs in the LayoutStore

Mirrors create_content_tab's registration (and Node's router.ts:701
layoutStore.createTab) into the fresh-agent POST /api/tabs path: the store
mints {tabId,paneId}, pane content is attached, and the TabRecord shadow is
recorded. Headless REST/MCP-created opencode panes are now visible to
GET /api/tabs + GET /api/panes, renamable via PATCH /api/panes/:id, and
DELETE /api/tabs/:id cleans their shadow maps. No rollback branch: the Rust
opencode create is a placeholder (no runtime call at create time), so no
failure path exists between allocation and response."
```

---

### Task 3: A3 — Remove the caller-less `syncPaneTitleByTerminalId` thunk

**Files:**
- Delete: `src/store/paneTitleSync.ts`
- Modify: `test/unit/client/store/tab-pane-title-sync.test.ts:11, 208, 248, 280, 323, 351`
- Modify: `test/e2e/title-sync-flow.test.tsx:16, 163, 200`

**Interfaces:**
- Consumes: `updatePaneTitleByTerminalId` reducer action from
  `src/store/panesSlice.ts` (existing; payload
  `{ terminalId: string; title: string; setByUser?: boolean }`).
- Produces: nothing (deletion).

Decision (justify in the commit message, per the ticket): **remove, do not
wire.** Evidence from recon: zero production callers/imports (only two test
files import it); its body is a 3-line pass-through to
`updatePaneTitleByTerminalId` whose only increment is `setByUser ?? false`;
the History-view session-rename job it was built for now belongs to
`applySessionRenameCascade` (`src/store/titleSync.ts:68-80`), which is
strictly stronger (adds a `sessionRef` walk reaching SDK panes and exited
terminals); all five wired pane-title write paths dispatch the reducer
directly with explicit `setByUser`; server persistence rides
`layoutMirrorMiddleware`'s `paneTitles` state diff, not any thunk. No
uncovered desync path exists.

- [ ] **Step 1: Prove zero production callers (RED-equivalent evidence)**

```bash
cd /home/dan/code/freshell/.worktrees/sweep-deferrals-deflake
grep -rn "paneTitleSync\|syncPaneTitleByTerminalId" src/ server/ shared/
```

Expected: hits ONLY in `src/store/paneTitleSync.ts` itself (the definition).
If any other production hit appears, STOP — the recon is stale; re-assess
before deleting.

- [ ] **Step 2: Substitute the dispatches in both test files**

`test/unit/client/store/tab-pane-title-sync.test.ts`:
- Line 11: replace
  `import { syncPaneTitleByTerminalId } from '../../../../src/store/paneTitleSync'`
  with an import of `updatePaneTitleByTerminalId` from
  `'../../../../src/store/panesSlice'` (merge into the existing panesSlice
  import line if the file already has one).
- Lines 208, 248, 280, 323, 351: replace each
  `await store.dispatch(syncPaneTitleByTerminalId({ terminalId: X, title: Y }))`
  with
  `store.dispatch(updatePaneTitleByTerminalId({ terminalId: X, title: Y, setByUser: false }))`
  (drop the `await`; the thunk passed `setByUser ?? false`, so the explicit
  `false` is behavior-identical — every assertion targets reducer output).

`test/e2e/title-sync-flow.test.tsx`:
- Line 16: replace the import with
  `import { updatePaneTitleByTerminalId } from '@/store/panesSlice'`.
- Lines 163 and 200: same substitution (keep the surrounding `act(...)`
  wrappers).

Do NOT change any assertion — they already target
`panes.paneTitles` / `paneTitleSetByUser` / `getTabDisplayTitle`.

- [ ] **Step 3: Run both focused suites with the thunk still present**

```bash
npm run test:vitest -- run test/unit/client/store/tab-pane-title-sync.test.ts
npm run test:vitest -- run test/e2e/title-sync-flow.test.tsx
```

Expected: PASS (proves the substitution is behavior-identical before the
deletion — this is the substitution's own green gate).

- [ ] **Step 4: Delete the thunk and verify nothing dangles**

```bash
git rm src/store/paneTitleSync.ts
grep -rn "paneTitleSync" src/ server/ shared/ test/ || echo "CLEAN"
npm run test:vitest -- run test/unit/client/store/tab-pane-title-sync.test.ts
npm run test:vitest -- run test/e2e/title-sync-flow.test.tsx
npm run test:vitest -- run test/unit/client/store/panesSlice.test.ts
```

Expected: grep prints `CLEAN`; all three suites PASS (`panesSlice.test.ts`
carries the direct reducer contract at `:3983-4145` and must be untouched).
Full typecheck lands in Task 7's `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add -A src/store test/unit/client/store/tab-pane-title-sync.test.ts test/e2e/title-sync-flow.test.tsx
git commit -m "refactor(client): remove caller-less syncPaneTitleByTerminalId thunk

Removed rather than wired: the naming-persistence sweep replaced its last
production caller (HistoryView now uses applySessionRenameCascade, which is
strictly stronger -- it adds a sessionRef walk reaching SDK panes and exited
terminals the terminalId walk cannot). All five wired pane-title write paths
dispatch updatePaneTitleByTerminalId directly with explicit setByUser, and
server persistence rides layoutMirrorMiddleware's paneTitles state diff, not
any thunk -- so the thunk plugged no desync path. Its 7 tests used it only
as a dispatch vehicle; they now dispatch the reducer action directly with
setByUser: false (what the thunk defaulted); assertions unchanged."
```

---

### Task 4: A4 (part 1) — `migrations` module: pure cleanup helper + marker I/O

**Files:**
- Create: `crates/freshell-server/src/migrations.rs`
- Modify: `crates/freshell-server/src/main.rs` (add `mod migrations;` beside the existing `mod settings_store;`-style declarations)
- Modify: `crates/freshell-server/src/settings_store.rs` (two new `impl SettingsStore` methods)

**Interfaces:**
- Consumes: `SettingsStore` internals `home: Option<Arc<PathBuf>>` and
  `ConfigLock::acquire(&dir)` (private to `settings_store.rs` — which is WHY
  the marker methods live there; everything else goes in the new module).
- Produces (Task 5 relies on these exact names):
  - `migrations::AI_TITLE_SHADOW_CLEANUP: &str` (= `"ai-title-shadow-cleanup"`)
  - `migrations::AUTHORITATIVE_TITLE_PROVIDERS: [&str; 1]` (= `["amplifier"]`)
  - `migrations::override_keys_to_clear(session_overrides: &serde_json::Map<String, Value>, authoritative: &[&str]) -> Vec<String>`
  - `SettingsStore::is_migration_done(&self, id: &str) -> bool`
  - `SettingsStore::mark_migration_done(&self, id: &str) -> std::io::Result<()>`
  - `SettingsStore::flush_to_disk(&self) -> std::io::Result<()>` (async; surfaces the persist result that `patch_session_override` swallows — Task 5's orchestration gates the marker on it)

Node reference semantics (must match exactly): a session-override key
qualifies for clearing when ALL of (`provider-title-cleanup.ts:17-30`):
(a) the provider parsed from the composite `"<provider>:<sessionId>"` key is
in the authoritative set — which is exactly `{"amplifier"}` (the only
`providesAuthoritativeTitle` implementer, `amplifier.ts:319-323`; Claude is
NOT in the set); (b) the row's `titleOverride` is truthy (absent/`null`/`""`
all disqualify); (c) `titleSource !== 'user'` — absent `titleSource` ALSO
qualifies. A key with no `:` parses as legacy provider `claude`
(`types.ts:122-131`) ⇒ never cleared. The marker is an optional top-level
`completedMigrations: string[]` in `~/.freshell/config.json`; `mark` is
append-only + idempotent (`config-store.ts:565-580`).

Structural-limit note: `settings_store.rs` is already over the 1K-line
guideline; the two marker methods plus `flush_to_disk` (~85 lines incl. doc
comments) must live there because `home`/`persist`/`ConfigLock` are private,
but ALL other A4 code and ALL A4 tests go in the new `migrations.rs` to
avoid growing it further. State this in the commit message.

- [ ] **Step 1: Write the failing helper tests**

Create `crates/freshell-server/src/migrations.rs`:

```rust
//! One-time boot migrations ported from Node's `startBackgroundTasks()`
//! (`server/index.ts:1039-1054`). Exactly one exists today:
//! `ai-title-shadow-cleanup`. Marker I/O lives on `SettingsStore`
//! (`is_migration_done` / `mark_migration_done`) because the config path and
//! `ConfigLock` are private to `settings_store.rs`.

use serde_json::Value;

/// Node's authoritative-title provider set: providers whose sessions always
/// carry their own AI-generated title. Derived in Node from
/// `providesAuthoritativeTitle()` -- amplifier is the ONLY implementer
/// (`server/coding-cli/providers/amplifier.ts:319-323`); Claude is NOT in
/// the set. Hardcoded: one implementer on both sides, a capability trait
/// would be speculative generality.
pub const AUTHORITATIVE_TITLE_PROVIDERS: [&str; 1] = ["amplifier"];

/// The migration id / `completedMigrations` marker string.
pub const AI_TITLE_SHADOW_CLEANUP: &str = "ai-title-shadow-cleanup";

/// Port of `overrideKeysToClear`
/// (`server/coding-cli/provider-title-cleanup.ts:17-30`). A key qualifies
/// when ALL hold: its provider (parsed from the composite key; a key with no
/// ':' is legacy provider "claude", `types.ts:122-131`, never authoritative)
/// is in `authoritative`; the row carries a truthy `titleOverride` (absent /
/// null / "" all disqualify -- JS truthiness); and `titleSource != "user"`
/// (absent titleSource ALSO qualifies). Explicit user renames are always
/// preserved.
pub fn override_keys_to_clear(
    session_overrides: &serde_json::Map<String, Value>,
    authoritative: &[&str],
) -> Vec<String> {
    let mut keys = Vec::new();
    for (key, row) in session_overrides {
        let provider = match key.split_once(':') {
            Some((p, _)) => p,
            None => "claude",
        };
        if !authoritative.contains(&provider) {
            continue;
        }
        let has_title = row
            .get("titleOverride")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty());
        if !has_title {
            continue;
        }
        if row.get("titleSource").and_then(Value::as_str) == Some("user") {
            continue;
        }
        keys.push(key.clone());
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn overrides(v: Value) -> serde_json::Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    // Ports of test/unit/server/coding-cli/provider-title-cleanup.test.ts
    // (4 cases) plus the two edge cases Node's parser implies.

    #[test]
    fn clears_authoritative_auto_written_titles() {
        let ov = overrides(json!({
            "amplifier:a1": { "titleOverride": "Auto", "titleSource": "ai" }
        }));
        assert_eq!(
            override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS),
            vec!["amplifier:a1".to_string()]
        );
    }

    #[test]
    fn skips_non_authoritative_provider() {
        let ov = overrides(json!({
            "claude:c1": { "titleOverride": "Auto", "titleSource": "ai" }
        }));
        assert!(override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS).is_empty());
    }

    #[test]
    fn skips_user_renames() {
        let ov = overrides(json!({
            "amplifier:a1": { "titleOverride": "Mine", "titleSource": "user" }
        }));
        assert!(override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS).is_empty());
    }

    #[test]
    fn skips_rows_without_title_override() {
        let ov = overrides(json!({
            "amplifier:a1": { "titleSource": "ai" },
            "amplifier:a2": { "titleOverride": "", "titleSource": "ai" },
            "amplifier:a3": { "titleOverride": null, "titleSource": "ai" }
        }));
        assert!(override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS).is_empty());
    }

    #[test]
    fn absent_title_source_still_qualifies() {
        let ov = overrides(json!({
            "amplifier:a1": { "titleOverride": "Auto" }
        }));
        assert_eq!(
            override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS),
            vec!["amplifier:a1".to_string()]
        );
    }

    #[test]
    fn legacy_unprefixed_key_parses_as_claude_and_is_skipped() {
        let ov = overrides(json!({
            "legacykey": { "titleOverride": "Auto", "titleSource": "ai" }
        }));
        assert!(override_keys_to_clear(&ov, &AUTHORITATIVE_TITLE_PROVIDERS).is_empty());
    }
}
```

Add `mod migrations;` to `crates/freshell-server/src/main.rs` next to the
other `mod` declarations.

- [ ] **Step 2: Run to verify RED, then GREEN**

```bash
cargo test -p freshell-server migrations::
```

The file above is written complete, so first run should PASS — the RED
phase for a pure port is the moment before the file exists (compile error
if the tests were added without the function). If you prefer a strict RED,
add the `#[cfg(test)]` block first, run (compile FAIL: `override_keys_to_clear`
not found), then add the implementation. Either way finish with all 6 tests
PASS.

- [ ] **Step 3: Commit the helper**

```bash
git add crates/freshell-server/src/migrations.rs crates/freshell-server/src/main.rs
git commit -m "feat(rust-server): port overrideKeysToClear for the ai-title-shadow cleanup

1:1 port of server/coding-cli/provider-title-cleanup.ts semantics: amplifier
is the only authoritative-title provider; truthy titleOverride; titleSource
!= 'user' (absent qualifies); legacy un-prefixed keys parse as claude and
are never cleared."
```

- [ ] **Step 4: Write the failing marker-I/O tests**

Append to `crates/freshell-server/src/migrations.rs` `mod tests`:

```rust
    use crate::settings_store::SettingsStore;

    /// Seeds a real config.json. `completed: None` = no marker key at all --
    /// NOTE the settings_store lossless fixture already seeds the marker
    /// (settings_store.rs:2511-2530), which would make a load-time migration
    /// pass accidentally; these tests therefore always build their own
    /// marker-free fixtures.
    fn seed_config(dir: &std::path::Path, session_overrides: Value, completed: Option<Value>) {
        let mut doc = json!({
            "version": 1,
            "settings": { "codingCli": {
                "enabledProviders": ["claude", "codex"],
                "knownProviders": ["claude", "codex"],
                "providers": {},
                "mcpServer": true
            } },
            "recentDirectories": ["/a", "/b"],
            "zzFutureKey": { "a": 1 },
            "sessionOverrides": session_overrides,
            "terminalOverrides": {},
            "projectColors": {}
        });
        if let Some(c) = completed {
            doc["completedMigrations"] = c;
        }
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        std::fs::write(
            dir.join(".freshell").join("config.json"),
            serde_json::to_string_pretty(&doc).unwrap(),
        )
        .unwrap();
    }

    fn store_at(dir: &std::path::Path) -> SettingsStore {
        SettingsStore::load(Some(dir), vec!["claude".into(), "codex".into()])
    }

    fn read_config(dir: &std::path::Path) -> Value {
        serde_json::from_str(
            &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
        )
        .unwrap()
    }

    // Mirrors test/unit/server/config-store.test.ts:975-997.
    #[test]
    fn migration_marker_roundtrip_is_idempotent_and_reload_visible() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        seed_config(dir, json!({}), None);
        let store = store_at(dir);
        assert!(!store.is_migration_done(AI_TITLE_SHADOW_CLEANUP));
        store.mark_migration_done(AI_TITLE_SHADOW_CLEANUP).unwrap();
        store.mark_migration_done(AI_TITLE_SHADOW_CLEANUP).unwrap();
        assert!(store.is_migration_done(AI_TITLE_SHADOW_CLEANUP));
        assert_eq!(
            read_config(dir)["completedMigrations"],
            json!([AI_TITLE_SHADOW_CLEANUP]),
            "append-only, no duplicates"
        );
        let reloaded = store_at(dir);
        assert!(reloaded.is_migration_done(AI_TITLE_SHADOW_CLEANUP));
    }

    #[test]
    fn mark_migration_done_preserves_unmanaged_document_state() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        seed_config(dir, json!({}), None);
        let store = store_at(dir);
        store.mark_migration_done(AI_TITLE_SHADOW_CLEANUP).unwrap();
        let cfg = read_config(dir);
        assert_eq!(cfg["recentDirectories"], json!(["/a", "/b"]));
        assert_eq!(cfg["zzFutureKey"], json!({ "a": 1 }));
        assert_eq!(cfg["completedMigrations"], json!([AI_TITLE_SHADOW_CLEANUP]));
    }
```

- [ ] **Step 5: Run to verify they fail to compile**

```bash
cargo test -p freshell-server migrations::
```

Expected: compile FAIL — `is_migration_done` / `mark_migration_done` not
found on `SettingsStore`.

- [ ] **Step 6: Implement the marker methods**

Add to the `impl SettingsStore` block in
`crates/freshell-server/src/settings_store.rs` (near
`session_overrides()` at `:671`):

```rust
    /// `configStore.isMigrationDone(id)` (`config-store.ts:565-568`): true
    /// when the optional top-level `completedMigrations` string array in
    /// `config.json` contains `id`. Reads disk directly -- the key stays an
    /// UNMANAGED copy-forward key (see `persist`), so a side-by-side Node
    /// append is never clobbered by in-memory state. A homeless store
    /// reports `true`: nothing can persist, so a marker-gated migration must
    /// never run.
    pub fn is_migration_done(&self, id: &str) -> bool {
        let Some(home) = &self.home else {
            return true;
        };
        let path = home.join(".freshell").join("config.json");
        let Ok(text) = std::fs::read_to_string(&path) else {
            return false;
        };
        let Ok(doc) = serde_json::from_str::<Value>(&text) else {
            return false;
        };
        doc.get("completedMigrations")
            .and_then(Value::as_array)
            .is_some_and(|list| list.iter().any(|v| v.as_str() == Some(id)))
    }

    /// `configStore.markMigrationDone(id)` (`config-store.ts:570-580`):
    /// append-only + idempotent. Whole read-modify-write under [`ConfigLock`]
    /// with the same atomic tmp+rename as `persist`, so no reader ever sees
    /// a torn document and other top-level keys round-trip untouched.
    /// HONEST LIMIT (mirrors [`ConfigLock`]'s own doc): this protects
    /// against a legacy Node that wrote FIRST and is now quiescent. A
    /// still-RUNNING legacy Node never re-reads config.json (cache-for-life,
    /// config-store.ts:401-412) and rewrites the WHOLE document from its
    /// stale cache on its next write, clobbering this marker (and any
    /// cleared rows). Bounded: the cleanup is idempotent and simply re-runs
    /// on the next Rust boot; `titleSource:"user"` rows are never touched.
    pub fn mark_migration_done(&self, id: &str) -> std::io::Result<()> {
        let Some(home) = &self.home else {
            return Ok(());
        };
        let dir = home.join(".freshell");
        std::fs::create_dir_all(&dir)?;
        let _lock = ConfigLock::acquire(&dir);
        let path = dir.join("config.json");
        let mut doc = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| serde_json::json!({}));
        let map = doc
            .as_object_mut()
            .expect("filtered to an object above, or defaulted to one");
        let list = map
            .entry("completedMigrations")
            .or_insert_with(|| serde_json::json!([]));
        match list.as_array_mut() {
            Some(items) => {
                if items.iter().any(|v| v.as_str() == Some(id)) {
                    return Ok(());
                }
                items.push(serde_json::json!(id));
            }
            None => {
                // Non-array garbage: coalesce like Node's `?? []`.
                *list = serde_json::json!([id]);
            }
        }
        let text = serde_json::to_string_pretty(&doc)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let tmp = dir.join(format!("config.json.tmp-{}", std::process::id()));
        std::fs::write(&tmp, &text)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Re-attempts a full settings persist and SURFACES the result.
    /// `patch_session_override` deliberately swallows persist errors
    /// (best-effort, `let _ = self.persist(..)`, :758-767); a marker-gated
    /// one-shot migration must not record completion on unknown persistence
    /// state, so it calls this once after its clears and aborts (retrying
    /// next boot) on failure -- matching Node, where a failed override write
    /// THROWS and the chain's .catch aborts before `markMigrationDone`
    /// (config-store.ts:195-210, :424-432; index.ts:1039-1058). Safe to call
    /// repeatedly: `persist` re-reads disk and overlays only dirty keys.
    pub async fn flush_to_disk(&self) -> std::io::Result<()> {
        let settings = self.get().await;
        self.persist(&settings)
    }
```

(Adapt the `ConfigLock::acquire(&dir)` call to the exact form `persist` uses
at `settings_store.rs:406-430` if the signature differs; likewise mirror
`persist`'s exact call shape inside `flush_to_disk` — the two-line body
above assumes `get()` is async and `persist(&Settings)` is sync, which is
how `patch_session_override` calls them at :758-767.)

- [ ] **Step 7: Run to verify GREEN, then the store's regression suite**

```bash
cargo test -p freshell-server migrations::
cargo test -p freshell-server settings_store::
```

Expected: all migrations tests PASS; every existing settings_store test
(esp. the three `*_preserves_unmanaged_top_level_document_state` R-DATALOSS
tests) still PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/freshell-server/src/settings_store.rs crates/freshell-server/src/migrations.rs
git commit -m "feat(rust-server): add completedMigrations marker I/O to SettingsStore

Ports config-store.ts isMigrationDone/markMigrationDone: append-only,
idempotent, disk read-modify-write under ConfigLock with atomic tmp+rename.
completedMigrations stays an UNMANAGED copy-forward key, so a Node append
that reached disk BEFORE a Rust persist survives (Rust re-reads disk fresh).
Validated limit, stated honestly: a still-RUNNING legacy Node writes the
whole document from a never-invalidated cache and clobbers the marker on
its next write -- side-by-side operation with a live Node is out of scope;
a clobbered marker only means a safe idempotent re-run next boot. Also adds
flush_to_disk, the Result-surfacing persist the migration orchestration
needs to avoid marking unpersisted clears as complete. Lives in
settings_store.rs only because home/persist/ConfigLock are private there;
all other migration code + tests live in the new migrations module to
respect the file-size guideline."
```

---

### Task 5: A4 (part 2) — `run_ai_title_shadow_cleanup` orchestration, boot wiring, SESSION-04 evidence

**Files:**
- Modify: `crates/freshell-server/src/migrations.rs` (orchestration + tests)
- Modify: `crates/freshell-server/src/main.rs` (boot wiring, after the warm-sweep block at `:636-656`)
- Modify: `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:147` (SESSION-04 evidence text)

**Interfaces:**
- Consumes (Task 4): `migrations::{AI_TITLE_SHADOW_CLEANUP, AUTHORITATIVE_TITLE_PROVIDERS, override_keys_to_clear}`,
  `SettingsStore::{is_migration_done, mark_migration_done, flush_to_disk}`; plus existing
  `SettingsStore::session_overrides(&self) -> serde_json::Map<String, Value>`
  (`settings_store.rs:671-679`) and
  `SettingsStore::patch_session_override(&self, key: &str, patch: &[(&str, Option<Value>)]) -> Value` (async, `settings_store.rs:681-769`),
  and the Task 4 test helpers `seed_config`/`store_at`/`read_config`.
- Produces: `pub async fn migrations::run_ai_title_shadow_cleanup(settings: &SettingsStore)`.

Node semantics to match (`server/index.ts:1039-1054`): guard on
`isMigrationDone` → compute keys → for each key
`patchSessionOverride(key, {titleOverride: undefined, titleSource: undefined})`
(clears BOTH title fields, preserves `summaryOverride`/`archived`/`deleted`/
`createdAtOverride`; the row itself is NOT deleted) → `markMigrationDone`
unconditionally (even with zero keys, so a clean home never re-scans). The
`(None, None)` patch bypasses the title-source ladder in BOTH
implementations (Node gates the ladder on both patch values being defined,
`config-store.ts:502-507`; Rust's `patches_title` + absent-after-removal
`next.get("titleSource")` has the same effect) — pin this with a test.
Node's trailing `codingCliIndexer.refresh()` needs NO Rust analogue: the
Rust session index is poll-based and `session_overrides()` freshness-reloads
(`maybe_reload_overrides`) — say so in a comment. Timing: Node runs this
fire-and-forget after boot; the condition reads ONLY `sessionOverrides`
(never live enrichment — Node's own comment), so a detached Rust boot task
is observationally equivalent. Error model (validated against the oracle):
Node's `patchSessionOverride` THROWS on a failed config write
(`atomicWriteFile` config-store.ts:195-210 → `saveInternal` :424-432 →
mutex :23-37, no catch anywhere) and the chain's `.catch`
(index.ts:1056-1058) aborts BEFORE `markMigrationDone`, so the migration
retries next boot. Rust's `patch_session_override` swallows persist errors
(`let _ = self.persist(..)`, settings_store.rs:758-767) — the orchestration
must therefore flush-and-check before marking (Step 3) to match.

- [ ] **Step 1: Write the failing orchestration tests**

Append to `crates/freshell-server/src/migrations.rs` `mod tests`:

```rust
    #[tokio::test]
    async fn cleanup_clears_amplifier_shadow_titles_and_marks_done() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        seed_config(
            dir,
            json!({
                "amplifier:a1": { "titleOverride": "Auto Name", "titleSource": "ai",
                                   "summaryOverride": "keep me", "archived": true },
                "amplifier:a2": { "titleOverride": "Mine", "titleSource": "user" },
                "amplifier:a3": { "titleOverride": "No Source" },
                "claude:c1":    { "titleOverride": "Auto", "titleSource": "ai" },
                "legacykey":    { "titleOverride": "Legacy", "titleSource": "ai" }
            }),
            None,
        );
        let store = store_at(dir);

        run_ai_title_shadow_cleanup(&store).await;

        let ov = store.session_overrides();
        let a1 = ov.get("amplifier:a1").unwrap();
        // titleSource "ai" is ladder-FINALIZED: the (None, None) clear must
        // bypass the can_upgrade_title gate, exactly like Node's
        // {undefined, undefined} patch (config-store.ts:502-507).
        assert!(a1.get("titleOverride").is_none(), "{a1:?}");
        assert!(a1.get("titleSource").is_none(), "{a1:?}");
        // Non-title fields on the row survive (Node: {...existing, ...patch}).
        assert_eq!(a1["summaryOverride"], json!("keep me"));
        assert_eq!(a1["archived"], json!(true));
        // Absent titleSource also qualifies.
        let a3 = ov.get("amplifier:a3").unwrap();
        assert!(a3.get("titleOverride").is_none(), "{a3:?}");
        // Untouched: user rename, non-authoritative provider, legacy key.
        assert_eq!(ov.get("amplifier:a2").unwrap()["titleOverride"], json!("Mine"));
        assert_eq!(ov.get("claude:c1").unwrap()["titleOverride"], json!("Auto"));
        assert_eq!(ov.get("legacykey").unwrap()["titleOverride"], json!("Legacy"));

        // Marker persisted; unmanaged keys preserved on disk.
        let cfg = read_config(dir);
        assert_eq!(cfg["completedMigrations"], json!([AI_TITLE_SHADOW_CLEANUP]));
        assert_eq!(cfg["recentDirectories"], json!(["/a", "/b"]));
        assert_eq!(cfg["zzFutureKey"], json!({ "a": 1 }));
        assert!(store.is_migration_done(AI_TITLE_SHADOW_CLEANUP));
    }

    #[tokio::test]
    async fn cleanup_never_reruns_once_marked() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        seed_config(
            dir,
            json!({ "amplifier:a1": { "titleOverride": "Would Qualify", "titleSource": "ai" } }),
            Some(json!([AI_TITLE_SHADOW_CLEANUP])),
        );
        let store = store_at(dir);
        run_ai_title_shadow_cleanup(&store).await;
        let ov = store.session_overrides();
        assert_eq!(
            ov.get("amplifier:a1").unwrap()["titleOverride"],
            json!("Would Qualify"),
            "marker present => migration must not run"
        );
    }

    #[tokio::test]
    async fn cleanup_marks_done_even_when_nothing_qualifies() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        seed_config(dir, json!({}), None);
        let store = store_at(dir);
        run_ai_title_shadow_cleanup(&store).await;
        assert!(store.is_migration_done(AI_TITLE_SHADOW_CLEANUP));
        // Second run: guard short-circuits, marker not duplicated.
        run_ai_title_shadow_cleanup(&store).await;
        assert_eq!(
            read_config(dir)["completedMigrations"],
            json!([AI_TITLE_SHADOW_CLEANUP])
        );
    }

    /// Error-model pin (validated divergence): a clear that cannot reach
    /// disk must NOT be recorded as complete -- Node aborts before
    /// markMigrationDone and retries next boot. Self-skips when the process
    /// can write through a read-only dir (e.g. root/CAP_DAC_OVERRIDE).
    #[tokio::test]
    async fn cleanup_skips_marker_when_clears_cannot_persist() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        seed_config(
            dir,
            json!({ "amplifier:a1": { "titleOverride": "Auto", "titleSource": "ai" } }),
            None,
        );
        let store = store_at(dir);
        let fdir = dir.join(".freshell");
        let mut ro = std::fs::metadata(&fdir).unwrap().permissions();
        ro.set_mode(0o555); // no tmp-file writes => persist AND mark both fail
        std::fs::set_permissions(&fdir, ro).unwrap();
        if std::fs::write(fdir.join("probe"), b"x").is_ok() {
            let _ = std::fs::remove_file(fdir.join("probe"));
            eprintln!("SKIP cleanup_skips_marker_when_clears_cannot_persist: read-only dir not enforceable here");
            return;
        }

        run_ai_title_shadow_cleanup(&store).await;

        let mut rw = std::fs::metadata(&fdir).unwrap().permissions();
        rw.set_mode(0o755);
        std::fs::set_permissions(&fdir, rw).unwrap();
        assert!(!store.is_migration_done(AI_TITLE_SHADOW_CLEANUP));
        let cfg = read_config(dir);
        assert_eq!(
            cfg["sessionOverrides"]["amplifier:a1"]["titleOverride"],
            json!("Auto"),
            "the clear never reached disk, so nothing may claim it did"
        );
    }
```

- [ ] **Step 2: Run to verify they fail to compile**

```bash
cargo test -p freshell-server migrations::
```

Expected: compile FAIL — `run_ai_title_shadow_cleanup` not found.

- [ ] **Step 3: Implement the orchestration**

Add to `crates/freshell-server/src/migrations.rs` (above the tests):

```rust
use crate::settings_store::SettingsStore;

/// Port of the one-time `ai-title-shadow-cleanup` migration
/// (`server/index.ts:1039-1054`): drop auto-written (non-user) title
/// overrides that shadow an authoritative provider-generated title (e.g.
/// Amplifier's own AI name). Guard -> compute -> clear -> flush -> mark, in
/// Node's order; the marker is written even when nothing qualified, so a
/// clean home never re-scans. Error model matches Node too: a failed
/// override write in Node THROWS and the chain's `.catch` aborts BEFORE
/// `markMigrationDone` (retry next boot) -- here, clears that cannot be
/// flushed to disk leave the migration unmarked (see below). Node's
/// trailing `codingCliIndexer.refresh()` deliberately has NO analogue here:
/// the Rust session index is poll-based and `session_overrides()`
/// freshness-reloads (`maybe_reload_overrides`), so the next sweep tick
/// already sees the cleared rows.
pub async fn run_ai_title_shadow_cleanup(settings: &SettingsStore) {
    if settings.is_migration_done(AI_TITLE_SHADOW_CLEANUP) {
        return;
    }
    let overrides = settings.session_overrides();
    let keys = override_keys_to_clear(&overrides, &AUTHORITATIVE_TITLE_PROVIDERS);
    for key in &keys {
        settings
            .patch_session_override(key, &[("titleOverride", None), ("titleSource", None)])
            .await;
    }
    if !keys.is_empty() {
        // `patch_session_override` swallows persist errors (best-effort,
        // settings_store.rs:758-767): a marker-gated one-shot must not
        // record completion on unknown persistence state. Re-flush and
        // abort unmarked on failure, mirroring Node's abort-before-marker.
        if let Err(err) = settings.flush_to_disk().await {
            tracing::warn!(
                event = "ai_title_shadow_cleanup_flush_failed",
                error = %err,
                "clears not persisted; leaving migration unmarked to retry next boot"
            );
            return;
        }
    }
    if let Err(err) = settings.mark_migration_done(AI_TITLE_SHADOW_CLEANUP) {
        tracing::warn!(
            event = "ai_title_shadow_cleanup_mark_failed",
            error = %err,
            "failed to persist the ai-title-shadow-cleanup marker"
        );
    }
    if !keys.is_empty() {
        tracing::info!(
            event = "ai_title_shadow_cleanup",
            cleared = keys.len(),
            "one-time stale AI-title cleanup complete"
        );
    }
}
```

- [ ] **Step 4: Run to verify GREEN**

```bash
cargo test -p freshell-server migrations::
```

Expected: all migrations tests PASS (helper + marker + 4 orchestration,
incl. the flush-failure pin, which self-skips only where a read-only dir
cannot be enforced).

- [ ] **Step 5: Wire it into boot**

In `crates/freshell-server/src/main.rs`, immediately AFTER the warm-sweep
block (`if let Some(index) = &session_index { ... tokio::spawn(...) }`,
`:636-656`), add:

```rust
    // One-time boot migration (Node chains it onto the coding-CLI indexer's
    // first full index, `server/index.ts:1039-1054`, fire-and-forget). The
    // cleanup condition reads ONLY `sessionOverrides` -- never the index or
    // live enrichment (Node's comment says exactly this) -- so a detached
    // task here is observationally equivalent to Node's post-index timing.
    {
        let migration_settings = settings_store.clone();
        tokio::spawn(async move {
            migrations::run_ai_title_shadow_cleanup(&migration_settings).await;
        });
    }
```

(`settings_store` is loaded at `main.rs:250` and cheap to clone — one `Arc`;
the auto-title sweep at `:668` clones it the same way.)

Verify it builds and nothing else regresses:

```bash
cargo check -p freshell-server
cargo test -p freshell-server
```

Expected: clean check; full crate suite PASS.

- [ ] **Step 6: Update the SESSION-04 checklist evidence (honestly)**

In `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`
line 147, inside the `MISSING for [x]:` clause, replace exactly this
sub-string:

> the one-time stale-AI-title cleanup + its marker are NOT ported (no `ai-title-shadow-cleanup` migration in `crates/` — Node runs it at `server/index.ts:1039-1052`; Rust's settings store only round-trips a pre-existing `completedMigrations` key);

with (fill `<sha>` with the Step 7 commit sha afterwards, or amend):

> the one-time stale-AI-title cleanup + its marker ARE ported (2026-08-XX sweep-deferrals-deflake, commit `<sha>`): `crates/freshell-server/src/migrations.rs` `run_ai_title_shadow_cleanup` wired as a detached boot task in `main.rs`, marker gated on a disk flush via `SettingsStore::{is_migration_done,mark_migration_done,flush_to_disk}`; tests `migrations::tests::{clears_authoritative_auto_written_titles, cleanup_clears_amplifier_shadow_titles_and_marks_done, cleanup_never_reruns_once_marked, cleanup_marks_done_even_when_nothing_qualifies, cleanup_skips_marker_when_clears_cannot_persist, migration_marker_roundtrip_is_idempotent_and_reload_visible}` — but line 146's Playwright "cleanup marker" assertion is still not e2e-proven;

The entry stays `- [ ]` / PARTIAL — the other two MISSING sub-criteria
(legacy-rung e2e, provider-authoritative e2e) remain unmet and MUST NOT be
touched. Use today's actual date.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-server/src/migrations.rs crates/freshell-server/src/main.rs docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md
git commit -m "feat(rust-server): port the one-time ai-title-shadow-cleanup boot migration

Node-equivalent semantics (server/index.ts:1039-1054): clears auto-written
(titleSource != 'user', absent qualifies) titleOverride+titleSource on
amplifier:* session overrides, preserves all other row fields, writes the
'ai-title-shadow-cleanup' completedMigrations marker even when nothing
qualified, never re-runs. The (None,None) patch bypasses the title-source
ladder exactly like Node's {undefined,undefined}. Error model matches Node
too: clears are flushed to disk before marking, and a failed flush leaves
the migration unmarked to retry next boot (Node throws out of the chain
before markMigrationDone). No indexer refresh
analogue needed: the Rust index is poll-based and session_overrides()
freshness-reloads. SESSION-04 checklist evidence narrowed accordingly
(stays PARTIAL: legacy-rung e2e + provider-authoritative e2e + PW marker
assertion still missing)."
```

If needed, amend the checklist line with the real sha:
`git commit --amend --no-edit` after editing.

---

### Task 5b: A4 (part 3) — Port Node's provider-generated read-guard (cleanup durability)

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs` (`apply_session_overrides`, `:663-686`; sole production caller `:403`)
- Modify: `crates/freshell-server/src/auto_title_sweep.rs:493-498` (the `SweepSession` title overlay; `s.title_source` is already in scope at `:505`)
- Tests: in each file's existing test module, following its current conventions

**Interfaces:**
- Consumes: `IndexedSession.title_source` (`directory_index.rs:75` — the provider-PARSED source; `"provider-generated"` for named amplifier sessions).
- Produces: behavioral only — `dir`/`first-message` override rows no longer shadow a provider-generated session title in listings or in the sweep's canonical-title push. No new named interfaces.

Background (validated 2026-08-09, load-bearing check): the auto-title sweep
re-writes a qualifying `dir` or `first-message` override for ANY amplifier
session with a live matching terminal within one 2s tick of Task 5's clear —
Node's write side does exactly the same (`server/auto-title.ts:24-46`; write
parity, so a write-side filter would be a deviation). Node stays correct
because its READ model hides such rows: `applyOverride`
(`server/coding-cli/session-indexer.ts:204-220`, the single choke point all
persisted-override display reads flow through) applies `titleOverride` only
when NOT (parsed `titleSource === 'provider-generated'` AND
`ov.titleSource ∈ {'dir','first-message'}`). The Rust port is missing this
guard (`apply_session_overrides` applies unconditionally), so WITHOUT this
task the A4 migration is observably ineffective: cleared amplifier titles
re-shadow within one tick under a permanently-set marker. This is a straight
parity port; no `DEVIATIONS.md` entry.

Guard semantics to mirror EXACTLY (`session-indexer.ts:204-220`):
- Apply the override title iff `titleOverride` is a NON-EMPTY string AND NOT
  (parsed source is `"provider-generated"` AND the row's `titleSource` is
  exactly `"dir"` or `"first-message"`).
- For provider-generated sessions, rows with `titleSource` `"ai"`, `"user"`,
  ABSENT, or any other value STILL apply (Node uses strict `===`).
- Rust today applies empty-string overrides where Node's `!!` does not — the
  non-empty check above fixes that in the same edit.

Scope guards (do NOT do):
- Do NOT guard the fresh-patch canonical push (`auto_title.rs:116-120`) —
  Node pushes the raw freshly-written patch title for one tick by design
  (`auto-title.ts:78`: `canonicalTitle = overridePatch?.titleOverride ??
  sessionTitle`); it self-corrects next tick. Guarding it would deviate.
- Do NOT add a write-side filter to the sweep (Node has none).
- CRITICAL: the guard applies ONLY to display/push titles.
  `compute_auto_title_patch`'s `existing_title_override`/
  `existing_title_source` inputs MUST keep reading the RAW override row —
  if the sweep saw a suppressed row as absent it would re-patch every tick
  (a config write storm Node does not have).

- [ ] **Step 1: Write the failing tests**

`session_directory` tests (RED — the first one fails today): a session whose
parsed `title_source` is `"provider-generated"` with an override row
`{ "titleOverride": "proj", "titleSource": "dir" }` must serve the PARSED
provider title. Matrix alongside it: `dir` suppressed; `first-message`
suppressed; `ai` applies; `user` applies; ABSENT `titleSource` applies;
empty-string `titleOverride` never applies (any session); a
non-provider-generated session + `dir` row still applies.

`auto_title_sweep` overlay test: a sweep session with
`title_source: Some("provider-generated")` and a `dir` override row keeps
the parsed title in the `SweepSession` mapping (the canonical-push input is
not driven to the dir basename).

- [ ] **Step 2: Run to verify RED**

```bash
cargo test -p freshell-server session_directory
cargo test -p freshell-server auto_title
```

Expected: the new tests FAIL (guard absent); all existing tests still PASS.

- [ ] **Step 3: Implement the guard at both sites**

Plumb the parsed `title_source` to where `apply_session_overrides` runs —
it is not on the item today; source it from `IndexedSession.title_source`
at the `dir_item_from_indexed` construction site (`:485` — verify the exact
spot) — then add the guard condition in `apply_session_overrides` and in
the sweep's title overlay (`auto_title_sweep.rs:493-498`).

- [ ] **Step 4: Verify GREEN, then the crate suite**

```bash
cargo test -p freshell-server session_directory
cargo test -p freshell-server auto_title
cargo test -p freshell-server
```

Expected: new tests PASS; full crate suite PASS.

- [ ] **Step 5: Extend the SESSION-04 evidence (same clause as Task 5 Step 6)**

In `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`
line 147, inside the clause Task 5 rewrote, insert immediately before
` — but line 146's Playwright`:

> , and the sweep re-shadowing gap is closed by the provider-generated read-guard port (commit `<sha>`): `apply_session_overrides` + the sweep title overlay now mirror `applyOverride`'s suppression (session-indexer.ts:204-220), with matrix tests in `session_directory`/`auto_title_sweep`

The entry stays `- [ ]` / PARTIAL.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-server/src/session_directory.rs crates/freshell-server/src/auto_title_sweep.rs docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md
git commit -m "fix(rust-server): port Node's provider-generated override read-guard

Parity port of applyOverride's suppression (session-indexer.ts:204-220):
dir/first-message override rows no longer shadow a provider-generated
session title in listings or the sweep's canonical-title push; ai/user/
absent-source rows still apply; empty-string overrides never apply (Node's
!! truthiness). Without this guard the ai-title-shadow-cleanup migration is
observably ineffective: the sweep (write-parity with Node, auto-title.ts:
24-46) re-creates a qualifying dir/first-message row for any live amplifier
session within one 2s tick of the clear, and Rust applied it
unconditionally. compute_auto_title_patch still reads the RAW row (no
write-side change), and the one-tick fresh-patch push stays unguarded --
both exactly as Node."
```

---

### Task 6: B — Deflake the `freshell-platform` live-netsh test

**Files:**
- Modify: `crates/freshell-platform/src/port_forward.rs` (tests module ONLY — zero production changes)
- Modify: `port/machine/specs/platform-glue.md:444` (P19 row)

**Interfaces:**
- Consumes: existing `CommandRunner` trait (`lib.rs:280-288`),
  `FakeCommandRunner::new().on(command, &[arg_needles], output)`
  (`lib.rs:382-432`), `CommandOutput::{success, failure, spawn_failure}`
  (`lib.rs:235-278`), `get_existing_port_proxy_rules(&dyn CommandRunner) -> Option<BTreeMap<u16, PortProxyRule>>`
  (`port_forward.rs:565`), `NETSH_PATH` const.
- Produces: env flag `FRESHELL_RUN_LIVE_WINDOWS_INTEROP=1` as the opt-in
  gate for live Windows-interop tests in this crate (Task 7 relies on the
  default suite being deterministic).

**The identified flake** (acceptance item 4 — identification is DONE):
`port_forward::tests::live_portproxy_and_firewall_show_readonly`
(`crates/freshell-platform/src/port_forward.rs:961-984`). Reproduced on this
host in
`/home/dan/code/freshell/.worktrees/.the-usual-logs/sweep-deferrals-deflake/platform-test-run1.log`:
`panicked at crates/freshell-platform/src/port_forward.rs:971:60: portproxy
show should succeed` (`158 passed; 1 failed`). It shells live
`netsh.exe interface portproxy show v4tov4` through `StdCommandRunner` (5s
kill-on-timeout) and `.expect()`s the `Option`;
`get_existing_port_proxy_rules` maps ANY non-zero exit or timeout to `None`,
so interop cold-start under parallel test threads, portproxy-subkey /
elevation state, or a disabled interop subsystem all panic it. The other
three `live_*` tests in the crate (`port_forward.rs:943` runs Linux `ip`,
`firewall.rs:571` asserts on an input-derived value, `network.rs:824` loops
a possibly-empty vec) CANNOT fail on interop state — they are deliberately
left un-gated so default runs keep exercising live Windows paths, per
`port/AGENTS.md`'s live-interop encouragement. Only the panicking test is
gated.

Gating-mechanism note (recorded decision, 2026-08-09): the acceptance
criterion for this work item explicitly requires the live variant behind an
explicit env flag, so the env-gate + early-return mechanism stands — even
though a validation census found all four existing gated Rust tests use
`#[ignore]` (`freshell-terminal/tests/wsl_interop_live.rs:81,116`,
`freshell-ws/tests/codex_managed_launch_e2e.rs:255`,
`directory_index.rs:1834`) and this flag is the first runtime env-gate
Rust-side. The `eprintln!` SKIP lines keep the skip visible in default-run
output (never silently green in the log).

Determinism pre-validation (2026-08-09, this host, worktree @ `92ccc51ac`):
15/15 consecutive `cargo test -p freshell-platform` runs green with only the
live portproxy test skipped (under above-normal load), and the flaky test
itself passed 5/5 solo runs the same day — the flake is real (captured log)
but rare and host-state-dependent. Step 5's 10/10 loop remains the
acceptance proof at the post-change HEAD.

No `DEVIATIONS.md` entry: this is a test-only defect fix, not a port-vs-Node
behavior change; the documented P19 expectation ("golden vs live netsh") is
updated in place to record the opt-in live leg.

- [ ] **Step 1: Backfill the hermetic coverage the live test was informally providing**

`get_existing_port_proxy_rules` currently has ZERO fake-driven tests. Add to
the `// ---- runner-backed reads via fakes ----` section of
`port_forward.rs`'s `mod tests` (next to
`existing_firewall_ports_missing_rule_is_empty_not_none` at `:921`):

```rust
    #[test]
    fn existing_port_proxy_rules_exit_zero_parses_rules() {
        // Transcribed live `netsh interface portproxy show v4tov4` output
        // (same fixture as parse_portproxy_keeps_only_0000_listen).
        let out = "\r\nListen on ipv4:             Connect to ipv4:\r\n\r\n\
Address         Port        Address         Port\r\n\
--------------- ----------  --------------- ----------\r\n\
127.0.0.1       8081        172.30.149.249  8081\r\n\
0.0.0.0         3001        172.30.149.249  3001\r\n";
        let runner = FakeCommandRunner::new().on(
            NETSH_PATH,
            &["portproxy", "show", "v4tov4"],
            CommandOutput::success(out),
        );
        let rules = get_existing_port_proxy_rules(&runner).expect("exit-0 show parses");
        assert_eq!(rules.len(), 1);
        assert!(rules.contains_key(&3001), "{rules:?}");
    }

    #[test]
    fn existing_port_proxy_rules_nonzero_exit_is_none() {
        let runner = FakeCommandRunner::new().on(
            NETSH_PATH,
            &["portproxy", "show", "v4tov4"],
            CommandOutput::failure(1, "", "The system cannot find the file specified.\r\n"),
        );
        assert_eq!(get_existing_port_proxy_rules(&runner), None);
    }

    #[test]
    fn existing_port_proxy_rules_timeout_or_spawn_failure_is_none() {
        // exit_code None is the timeout/kill/spawn-failure channel
        // (CommandOutput doc, lib.rs:224-233).
        let runner = FakeCommandRunner::new().on(
            NETSH_PATH,
            &["portproxy", "show", "v4tov4"],
            CommandOutput::spawn_failure("timed out"),
        );
        assert_eq!(get_existing_port_proxy_rules(&runner), None);
    }
```

(Match `CommandOutput::success`'s exact parameter type to the existing
constructor — the sibling tests at `:921-939` show the call shapes.)

These are characterization tests of existing behavior — they should PASS
immediately (not a TDD red; the red for this task is the flake itself,
already captured in the run log).

```bash
cargo test -p freshell-platform existing_port_proxy_rules
```

Expected: 3 PASS.

- [ ] **Step 2: Gate the live test behind an explicit env flag + honest probe + diagnostics**

Replace `live_portproxy_and_firewall_show_readonly`
(`port_forward.rs:961-984`) entirely with:

```rust
    /// Two-part interop probe (cf.
    /// crates/freshell-terminal/tests/wsl_interop_live.rs:18-21): the /mnt/c
    /// mount alone does not imply the Win32 interop subsystem is up.
    fn wsl_interop_available() -> bool {
        std::path::Path::new(NETSH_PATH).exists()
            && std::path::Path::new("/proc/sys/fs/binfmt_misc/WSLInterop").exists()
    }

    /// P19 (`LV? = yes`): the real `portproxy show v4tov4` + firewall `show
    /// rule` reads. READ-ONLY; asserts parse-shape only, never mutates.
    ///
    /// OPT-IN (deflake, 2026-08): live netsh from WSL is environment-
    /// dependent -- interop cold-start vs the runner's 5s kill-on-timeout,
    /// portproxy-subkey/elevation state -- and failed intermittently in
    /// default runs (`get_existing_port_proxy_rules` maps any non-zero exit
    /// or timeout to `None`). Hermetic FakeCommandRunner coverage of the
    /// same read lives above; this live leg runs only when explicitly
    /// requested, mirroring the repo's opt-in live-test convention
    /// (FRESHELL_RUN_REAL_PROVIDER_CONTRACTS):
    ///
    ///   FRESHELL_RUN_LIVE_WINDOWS_INTEROP=1 cargo test -p freshell-platform live_portproxy
    #[test]
    fn live_portproxy_and_firewall_show_readonly() {
        if std::env::var("FRESHELL_RUN_LIVE_WINDOWS_INTEROP").as_deref() != Ok("1") {
            eprintln!(
                "SKIP live_portproxy_and_firewall_show_readonly: set \
FRESHELL_RUN_LIVE_WINDOWS_INTEROP=1 to run live netsh interop"
            );
            return;
        }
        if !wsl_interop_available() {
            eprintln!("SKIP live_portproxy_and_firewall_show_readonly: WSL interop unavailable");
            return;
        }
        let runner = crate::StdCommandRunner::default();

        let rules = get_existing_port_proxy_rules(&runner).unwrap_or_else(|| {
            // Surface WHAT failed: the production read discards
            // exit_code/stderr, so re-run the raw command for diagnostics.
            let out = runner.run(NETSH_PATH, &["interface", "portproxy", "show", "v4tov4"]);
            panic!(
                "portproxy show should succeed; retry exit={:?} stderr={:?} stdout={:?}",
                out.exit_code, out.stderr, out.stdout
            );
        });
        for (listen, r) in &rules {
            assert!(*listen >= 1);
            assert!(
                is_ipv4_shape(&r.connect_address),
                "connect addr shape: {r:?}"
            );
        }
        eprintln!("LIVE portproxy rules (read-only): {} rule(s)", rules.len());

        // READ-ONLY show; tolerates the missing-rule signature.
        let ports = get_existing_firewall_ports(&runner).expect("firewall show should resolve");
        eprintln!("LIVE FreshellLANAccess ports (read-only): {ports:?}");
    }
```

- [ ] **Step 3: Update the P19 acceptance row so the documented expectation stays honest**

In `port/machine/specs/platform-glue.md:444`, the P19 row's final (LV)
cell currently reads `**yes** (read)`. Change it to:

```
**yes** (read; live leg opt-in via FRESHELL_RUN_LIVE_WINDOWS_INTEROP=1)
```

(the golden half of "golden vs live netsh" remains in the default suite —
`parse_portproxy_keeps_only_0000_listen` plus the new fake-driven reads).

- [ ] **Step 4: Verify the crate suite, then run the live leg once for the record**

```bash
cargo test -p freshell-platform
FRESHELL_RUN_LIVE_WINDOWS_INTEROP=1 cargo test -p freshell-platform live_portproxy_and_firewall_show_readonly -- --nocapture
```

Expected: first run — all tests PASS with the live test printing its SKIP
line. Second run — the live leg executes; if it fails, record the new
diagnostic output (exit/stderr) in the commit message body and continue: it
is opt-in and environment-dependent by design; do NOT gate this task on it.

- [ ] **Step 5: Prove determinism — 10/10 consecutive green with no env flags**

```bash
cd /home/dan/code/freshell/.worktrees/sweep-deferrals-deflake
for i in $(seq 1 10); do
  cargo test -p freshell-platform --quiet || { echo "FLAKE on run $i"; exit 1; }
done && echo "10/10 GREEN"
```

Expected: `10/10 GREEN` (acceptance bar; after the first compile the runs
are sub-second). If ANY run fails, the deflake is incomplete — identify the
failing test and fix before proceeding.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-platform/src/port_forward.rs port/machine/specs/platform-glue.md
git commit -m "fix(platform): deflake live portproxy test -- env-gate it, backfill hermetic reads

live_portproxy_and_firewall_show_readonly shells live netsh.exe and
.expect()ed a read that maps any non-zero exit or timeout to None; it failed
intermittently on this host (captured: 'portproxy show should succeed',
158 passed/1 failed). It now runs only with
FRESHELL_RUN_LIVE_WINDOWS_INTEROP=1 (repo opt-in convention), probes the
interop subsystem (binfmt WSLInterop), and surfaces exit/stderr on failure.
get_existing_port_proxy_rules gains the fake-driven success/exit-1/timeout
coverage the live test was informally providing. The other three live_*
tests cannot panic on interop state and stay un-gated (live verification by
default per port/AGENTS.md). platform-glue.md P19 row updated to record the
opt-in live leg. Verified: cargo test -p freshell-platform 10/10 green with
no env flags."
```

---

### Task 7: Full gates, merge back to `feat/rust-tauri-port`, push (NO PR)

**Files:** none created; git operations + gate runs only.

**Interfaces:**
- Consumes: all prior tasks committed on the worktree branch.
- Produces: `origin/feat/rust-tauri-port` advanced to include this work.

- [ ] **Step 1: Purity invariant (frozen Node reference untouched)**

```bash
cd /home/dan/code/freshell/.worktrees/sweep-deferrals-deflake
git fetch origin
git diff --name-only origin/feat/rust-tauri-port -- server/ shared/
git diff --name-only origin/feat/rust-tauri-port -- src/
```

Expected: first diff EMPTY — any file listed is a frozen-tree violation that
must be reverted before delivery. Second diff: EXACTLY
`src/store/paneTitleSync.ts` (the sanctioned A3 deletion). Record that
enumeration in the merge-commit body (precedent: the prior campaign recorded
its sanctioned src/ delta the same way — "src/ diff = exactly the N task
files. PASS"). Any other src/ file = unsanctioned; revert or justify before
delivery. (Adjudicated during validation: `port/HANDOFF.md` §8.3's
per-commit purity command includes `src/`, but the binding delivery gate for
this campaign is `server/ shared/` — the deferral ledger itself mandates
this src/ removal, and port/AGENTS.md precedence plus prior-campaign
precedent both accept an enumerated, sanctioned src/ delta.)

- [ ] **Step 2: Rust gates**

```bash
cargo test --workspace --exclude freshell-tauri
cargo test -p freshell-tauri
```

Expected: all PASS (use a generous timeout — full workspace compiles). The
tauri crate was not touched but the end-of-execution gate includes it.
Baseline note (validated 2026-08-09 at `92ccc51ac`, this worktree): all four
delivery gates were green before execution started, so any red here is
attributable to this branch — triage it; do not dismiss it as pre-existing.

- [ ] **Step 3: TS gates (coordinator-gated — wait, never kill)**

```bash
npm run check
npm run lint
```

Expected: PASS. `npm run check` is the coordinated typecheck + full Vitest
suite: if another run holds the coordinator, WAIT for it — never kill a
foreign run. Two KNOWN environmental flakes exist (codex-app-server 50ms
timeout; `command -v codex` 5s probe): if one of those specific specs fails
in an area this branch did not touch, re-run it focused
(`npm run test:vitest -- run <that file>`) to confirm it is environmental,
and note it in the merge-commit body rather than chasing it.

- [ ] **Step 4: Merge back and push (campaign convention: merge commit, NO PR, never main)**

```bash
cd /home/dan/code/freshell/.worktrees/sweep-deferrals-deflake
WORK_BRANCH=$(git branch --show-current)
git fetch origin
# If origin/feat/rust-tauri-port advanced past our base, integrate it FIRST
# and re-run Step 2's fast gate before merging back:
git merge origin/feat/rust-tauri-port
git checkout --detach origin/feat/rust-tauri-port
git merge --no-ff "$WORK_BRANCH" -m "Merge ${WORK_BRANCH}: close naming-sweep ledger deferrals (A1-A4) + deflake platform live netsh test"
git push origin HEAD:feat/rust-tauri-port
git checkout "$WORK_BRANCH"
```

Expected: push succeeds to `feat/rust-tauri-port`. **Do NOT open a PR
(campaign directive). Do NOT push `main` or any other branch.** If the
`git merge origin/feat/rust-tauri-port` step pulled in changes, re-run
`cargo test --workspace --exclude freshell-tauri` and `npm run check` before
the detached merge + push.

- [ ] **Step 5: Confirm delivery**

```bash
git ls-remote origin feat/rust-tauri-port
git log --oneline -3 origin/feat/rust-tauri-port
```

Expected: the remote ref equals the merge commit just created and its
first-parent chain contains all task commits.

---

## Acceptance ↔ Task map (verification matrix)

| Acceptance criterion | Proven by |
|---|---|
| 1. REST/MCP fresh-agent tabs visible in GET /api/tabs + /api/panes, renamable via PATCH, with tests | Task 2 (3 new tests incl. rename + delete-cleanup) |
| 2. TabRecord write-only fields gone; thunk removed-or-wired with justification | Task 1 (compiler-clean removal), Task 3 (removal + commit-message justification) |
| 3. ai-title-shadow-cleanup ported w/ Node semantics + marker + tests; SESSION-04 evidence updated honestly | Tasks 4-5 (helper/marker/orchestration tests incl. flush-gated marker, boot wiring, checklist edit stays PARTIAL) + Task 5b (read-guard port making the cleanup durable/observable) |
| 4. Flaky test identified; default `cargo test -p freshell-platform` 10/10 green; live variant behind explicit env flag | Task 6 (identified test + log evidence; env gate FRESHELL_RUN_LIVE_WINDOWS_INTEROP; 10x loop) |
| 5. Full suite green; merged to feat/rust-tauri-port; pushed; NO PR; nothing to main | Task 7 |
