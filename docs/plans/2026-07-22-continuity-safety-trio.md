# Continuity Safety Trio Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Give freshell's Rust port a continuity safety net: durable tabs-sync snapshot generations with a one-command restore, a 3-minute real-CLI continuity smoke test as a pre-deploy gate, and a read-only deploy tab-diff ritual script.

**Architecture:** All server work is additive in `crates/` (the client `src/`, `shared/`, and legacy `server/` are FROZEN). Deliverable 1 persists the tabs-sync registry's per-device snapshots to `~/.freshell/tabs-snapshots/` (last 5 generations per device) and adds read + restore REST endpoints that rebuild tabs by driving the existing, proven `POST /api/tabs` create pipeline. Deliverable 2 is one Playwright scenario against the real `freshell-server` binary and the REAL `codex`/`amplifier`/`claude` CLIs, registered outside the default test matrix. Deliverable 3 is a read-only bash script (`capture`/`verify`) over the new snapshot GETs plus the existing `GET /api/terminals`, with an e2e proof that it fails loudly on identity loss.

**Tech Stack:** Rust (axum, serde_json, tokio) in `crates/freshell-ws` + `crates/freshell-server` + `crates/freshell-freshagent`; Playwright (`test/e2e-browser/`, `RustServer` harness); bash + curl + jq operator scripts.

## Global Constraints

- Integration branch is `feat/rust-tauri-port` (already on origin) — commit and push THERE. Do NOT create a PR to main and do NOT touch `origin/main`. This worktree branch (`feat/continuity-safety-trio`, based on `136b9e94`) lands back onto `feat/rust-tauri-port`.
- FROZEN read-only paths: `server/`, `shared/`, `src/`. NO edits to any file under these, ever. If a task appears to require a client change, STOP and surface it — do not edit.
- Do NOT touch `dist/client` (the live production server serves it from disk).
- NEVER touch ports 3001/3002 or any process you did not spawn (the user's production server + live tabs run on :3002). All testing on ephemeral ports with throwaway HOMEs (the `RustServer` harness does this by design). `scripts/deploy-tab-diff.sh` may only be TESTED against ephemeral servers.
- Rust tests: `cargo test -p <crate>`. TS/vitest via the coordinated wrapper: `npm run test:vitest -- ...` (check `npm run test:status` before broad runs). E2e: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=<project> <spec>`.
- Commit messages: conventional commits + the Amplifier co-author footer used on this branch (see any recent commit, e.g. `136b9e94`):

  ```
  🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

  Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
  ```

- Keep each deliverable independently landable, in order: Deliverable 1 (Tasks 1–5) → Deliverable 2 (Tasks 6–8) → Deliverable 3 (Tasks 9–10).
- `README.md` is the only end-user markdown doc; this plan and the evidence file under `docs/plans/` are working/agent docs (allowed).
- Beyond-legacy behavior introduced here (snapshot persistence + new endpoints) gets a `port/oracle/DEVIATIONS.md` ledger entry (Task 3, Step 7).

## Key facts discovered (verified at HEAD `136b9e94`, worktree-relative paths)

- Tabs-sync registry: `crates/freshell-ws/src/tabs.rs` — in-memory `TabsRegistry` (`Arc<Mutex<State>>`), records held as opaque `serde_json::Value` (identity fields survive verbatim). Push handler: `crates/freshell-ws/src/terminal.rs:1610-1648` (`handle_tabs_push` → `state.tabs.replace_client_snapshot(...)`). Constructed at `crates/freshell-server/src/main.rs:274` (`let tabs = freshell_ws::tabs::TabsRegistry::new();`), shared with the REST retire beacon (`crates/freshell-server/src/boot.rs:63-93`).
- What the client pushes today (frozen `src/lib/tab-registry-snapshot.ts:15-66`): each record has `tabKey` (= `${deviceId}:${tabId}`), `tabId`, `tabName`, `status`, `revision`, `updatedAt`, `paneCount`, `panes[]`; each pane snapshot is `{paneId, kind, payload}` where terminal payload = `{mode, shell, sessionRef, codexDurability?, liveTerminal: {terminalId, serverInstanceId}?, initialCwd}` and fresh-agent payload includes `provider`, `sessionRef`, `initialCwd`. **`sessionRef {provider, sessionId}` is already pushed** — persistence must simply not drop it (records are opaque `Value`s, so it won't).
- Home resolution: `FRESHELL_HOME` else `HOME` (`crates/freshell-server/src/main.rs:16,120`); server disk state lives under `<home>/.freshell/` (`settings_store.rs:164`).
- `POST /api/tabs` (the proven create pipeline): `crates/freshell-freshagent/src/lib.rs:1150-1171` (`create_tab`; `agent` absent → `terminal_tabs::create_terminal_or_content_tab(state, body).await`); terminal path `crates/freshell-freshagent/src/terminal_tabs.rs:189-224,952-1046` — body keys `mode`, `cwd`, `name`, `sessionRef` (honored when `sessionRef.provider == mode` via `accepted_session_ref_for_mode`, `terminal_tabs.rs:82-87`), `resumeSessionId` (legacy; rejected with HTTP 400 for codex, `terminal_tabs.rs:113-133,62`), `browser: <url>`, `editor: <filePath>`.
  - **RESPONSE ENVELOPE (verified `terminal_tabs.rs:1040-1043,267` via the `ok_json`/`fail_json` helpers at `lib.rs:1106-1133`):** success is `{ "status":"ok", "data": {<ids>}, "message":"tab created" }` — NOT a flat id object. For a terminal tab `data = {tabId, paneId, terminalId}`; for a content (browser/editor) tab `data = {tabId, paneId}` (NO `terminalId`). Errors are `{ "status":"error", "message": <msg> }` at a non-2xx HTTP status (no `data` key). **Every consumer in this plan MUST unwrap `.data` (Rust: `resp_body["data"]["tabId"]`; JS: `body.data.terminalId`).**
  - Success also broadcasts `ui.command{tab.create}` to ALL connected clients on the shared bus (no device/client targeting — `lib.rs:305-311`, comment "broadcast to ALL clients"); connected clients fold it into Redux via `src/lib/ui-commands.ts:79` (`addTab` is unconditional — every browser adds the tab; see restore broadcast handling in Task 3). The terminal `tab.create` payload carries `paneContent.sessionRef` (`terminal_tabs.rs:995-1010`), so the receiving client's Redux pane gets `content.sessionRef` — this is the uniform, provider-agnostic same-session evidence source used by `codex-terminal-bounce-rust.spec.ts` (`harness.getPaneLayout(tabId).content.sessionRef`).
  - A session-provider create carrying NEITHER `sessionRef` NOR `resumeSessionId` still SUCCEEDS and returns the normal envelope (only logs the `tab_create_missing_session_identity` WARN, target `freshell_ws::invariants`, `terminal_tabs.rs:1020-1033`). `is_session_provider_mode` = amplifier|opencode|claude|gemini|kimi (codex/shell excluded).
- REST auth: `x-auth-token` header (or cookie) — `is_authed`/`unauthorized` are `pub(crate)` in `crates/freshell-server/src/boot.rs:686,713`; import as `use crate::boot::is_authed;`.
- Live terminal registry REST: `GET /api/terminals` (`crates/freshell-server/src/terminals.rs:103,395-530`) is **BRANCHED (verified `terminals.rs:403-415`)**: with NO read-model query param it returns a **RAW JSON ARRAY** of items (`Json(Value::Array(items))`, line 414); the `{items, nextCursor, revision}` PAGED shape is returned ONLY when any of `cursor`/`priority`/`revision`/`limit` is present, AND `priority` (`"visible"|"background"`) is then REQUIRED (else HTTP 400, `terminals.rs:428-437`). **This plan uses the RAW-ARRAY form (no query params): iterate the array directly (JS `terms.filter(...)`, jq `.[]`), NEVER `terms.items`.** Each item: `terminalId`, `title`, `mode`, `sessionRef?`, `createdAt`, `lastActivityAt`, `status`, `hasClients`, `cwd?`, `lastLine`. **`sessionRef` is DELIBERATELY OMITTED for `mode == "codex"` (and `"shell"`) items (`terminals.rs:674-682`)** and is only synthesized (`{provider:mode, sessionId:resumeSessionId}`) for non-codex/non-shell modes — so codex same-session identity MUST be asserted via the Redux pane (`harness.getPaneLayout(tabId).content.sessionRef`), never via `/api/terminals`. Also `GET /api/terminals/{id}/search?q=...` (`terminals.rs:108,382-392`) returns `{ "matches":[{line,column,text}], "nextCursor": <string|null> }` — assert `.matches.length` (the strongest offline proof a CLI rendered text into a pane). `DELETE /api/terminals/{id}` (`terminals.rs:1018-1035`) only writes a `{deleted:true}` settings override + broadcasts `terminals.changed`; it does NOT kill the PTY or close a UI tab (do NOT use it to simulate pane loss).
- Router assembly: `crates/freshell-server/src/main.rs:620-663` (`.merge(...)` chain) — new routers merge there.
- E2e harness (verified against `codex-terminal-bounce-rust.spec.ts`, the canonical rust-only sibling): specs do NOT `new RustServer(...)` directly and there is **NO `bootAndConnect` and NO `harnessReady` export**. The sibling pattern is:
  - Boot: `import { createE2eServerHandle } from '../helpers/external-target.js'`; `const server = await createE2eServerHandle(process.env, { kind: e2eServerKind, construct: { env, setupHome } })` (routes to `RustServer` when `kind==='rust'`; `construct.env`/`construct.setupHome` are the RustServer options). `const info = await server.start()`. `server.restart()` exists (same home/port/token; browser WS auto-reconnects). `info: TestServerInfo` = `{port, baseUrl, wsUrl, token, configDir, homeDir, logsDir, debugLogPath, pid, runtimeRoot}` (`helpers/test-server.ts:14-25`).
  - Connect: `import { TestHarness } from '../helpers/test-harness.js'`; `await page.goto(\`${info.baseUrl}/?token=${info.token}&e2e=1\`)`; `const harness = new TestHarness(page); await harness.waitForHarness(); await harness.waitForConnection();` (plus `selectShellIfPickerShowing(page)` copied from the sibling for shell panes). For a second/reconnected page use another `new TestHarness(page2)`.
  - Reconnect-after-restart wait (copy verbatim from `codex-terminal-bounce-rust.spec.ts:229-239`): poll `page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())` for `'ready'` inside `expect(async () => {...}).toPass({timeout:60_000})`. Do NOT invent `harnessReady`; do NOT read `.connection` off `harness.getState()` synchronously.
  - `TestHarness` methods (all are `async`, return a Promise — `await` them): `getTabCount()`, `getActiveTabId()`, `getState()` (Redux state; has `.tabs.tabs[]` each with `.id`/`.mode`, `.connection.status`), `getPaneLayout(tabId)` (→ `.content.terminalId`, `.content.sessionRef` — the uniform same-session evidence, works for codex), `waitForTabCount(n)`. **The frozen `import { test, expect } from '../helpers/fixtures.js'`** is the source of `test`/`expect` and the `e2eServerKind` worker option.
  - Debug logs: read `info.logsDir` (the Rust logger writes `<home>/.freshell/logs/rust-server.jsonl`, `logging.rs:74`). **Do NOT use `info.debugLogPath`** — for a Rust server it is set to the WRONG filename `freshell-server.rust.<port>.log` (`rust-server.ts:376`), which the logger never writes. Sibling specs read logs via `fs.readdir(info.logsDir)` + concat (`codex-terminal-bounce-rust.spec.ts:89-93`).
- Playwright projects: `test/e2e-browser/playwright.config.ts:95-178` — `chromium` (no `testMatch` AND no `testIgnore` → `testDir:'./specs'` makes it match EVERY spec; supplies the fixture-default `e2eServerKind:'legacy'`), CI-only `firefox`/`webkit` (also match-all, also `'legacy'`), and `legacy-chromium`/`rust-chromium` with explicit `testMatch` lists. **A rust-only spec's in-body `expect(e2eServerKind).toBe('rust')` does NOT keep it out of the match-all projects — it makes the spec FAIL there (`expect('legacy').toBe('rust')`).** A new rust-only spec MUST therefore be (a) appended to `rust-chromium`'s `testMatch`, AND (b) added to a `testIgnore` array on EVERY match-all project (`chromium`, and the CI `firefox`/`webkit`) — this is what Task 7 does for `continuity-smoke`; Tasks 5 and 10 must do the same for their specs.
- Session fixture formats already used in-repo (mirror these):
  - codex: `<home>/.codex/sessions/YYYY/MM/DD/rollout-<ISO-with-dashes>-<uuid>.jsonl`, lines `{timestamp, type:'session_meta', payload:{id, cwd}}` then `{type:'response_item', payload:{type:'message', role, content:[{type:'input_text'|'output_text', text}]}}` (`test/e2e-browser/specs/sidebar-click-resume.spec.ts:175-208`; real codex nests under `sessions/YYYY/MM/DD/`, `crates/freshell-sessions/src/directory_index.rs:327-333,412-413`).
  - amplifier: `<home>/.amplifier/projects/<slug>/sessions/<id>/metadata.json` (`{session_id, working_dir, created, name, description}`) + sibling `transcript.jsonl` (`sidebar-click-resume.spec.ts:325-350`; `crates/freshell-sessions/src/amplifier.rs:1-57`).
  - claude: `<home>/.claude/projects/<munged-cwd>/<sessionId>.jsonl` (cwd path separators → `-`; `crates/freshell-sessions/src/directory_index.rs:154-205`). Claude session ids must be canonical UUIDs (`terminal_tabs.rs:162-166`).
- The historical bug for the Deliverable 2 proof: at `136b9e94~1` the WS `terminal.create` codex arm read ONLY `resumeSessionId` and ignored `sessionRef`, so every codex open/restore spawned plain `codex` with no resume args (see `git show 136b9e94`). A codex leg that asserts seeded-history visibility MUST fail there and pass at HEAD.
- Real CLIs on this host: `codex` (codex-cli 0.145.0), `amplifier` (`~/.local/bin/amplifier`), `claude` (2.1.218), `jq` at `/usr/bin/jq`.
- Load-bearing validation findings (this plan's anchors re-verified at HEAD; ledger in the run's logs dir):
  - `pub mod terminal_tabs` is ALREADY public (`crates/freshell-freshagent/src/lib.rs:44`) — Task 3's visibility change is exactly the fn `pub(crate) async fn create_terminal_or_content_tab` (`terminal_tabs.rs:189`) → `pub`, nothing else.
  - A session-provider `POST /api/tabs` create carrying NEITHER `sessionRef` nor `resumeSessionId` SUCCEEDS: it logs the `tab_create_missing_session_identity` WARN (`terminal_tabs.rs:1023-1033`), still broadcasts `ui.command{tab.create}` and returns `{tabId, paneId, terminalId}` — so Task 10's failure-path "fresh codex, NO sessionRef" create works as written (expect that WARN in the ephemeral server's logs; it is unrelated to the `terminal_identity_unresolved` invariant WARN).
  - The `/api/tabs-sync/*` REST namespace is free except `client-retire` (`boot.rs:91`); `freshell_freshagent::snapshot::router` serves only `/api/fresh-agent/threads/...` — no collision for the new `snapshots`/`restore` routes.
  - The default `chromium` Playwright project (and CI `firefox`/`webkit`) match EVERY spec and supply `e2eServerKind:'legacy'`; the in-spec `expect(e2eServerKind).toBe('rust')` guard makes a rust-only spec FAIL there, it does NOT exclude it. Every new rust-only spec here (Tasks 5, 7, 10) MUST both append to `rust-chromium`'s `testMatch` AND add a `testIgnore` entry to each match-all project.
  - `create_terminal_or_content_tab` is `pub(crate)` at `terminal_tabs.rs:189` and `pub mod terminal_tabs` is already public (`lib.rs:44`) with NO crate-root re-export. Task 3 changes ONLY that fn's visibility to `pub`, then calls it by full path `freshell_freshagent::terminal_tabs::create_terminal_or_content_tab(state, body).await`. No re-export is needed (or added).
  - `FreshAgentState` has NO `new_for_tests`. Construct it in tests exactly as `terminal_tabs.rs:1394-1402` does: `let (tx,_rx)=tokio::sync::broadcast::channel::<String>(64); FreshAgentState::new(Arc::new(TOKEN.to_string()), Arc::new(tx)).with_terminal_registry(freshell_terminal::TerminalRegistry::new())` (both `new` and `with_terminal_registry` are `pub`; `freshell-server` already depends on `freshell-terminal` and `tokio`).
  - **Restore identity/idempotency substrate:** the REST `POST /api/tabs` create path does NOT synchronously upsert `TerminalIdentityRegistry` for codex (only the WS `terminal.create` path does, `terminal.rs:1193`; REST codex identity is never written there — `terminal_tabs.rs:778-791` documents this gap). So post-create identity CANNOT be re-verified via that registry for codex. Restore therefore proves identity by (i) a PREFLIGHT that rejects any terminal pane whose snapshot `sessionRef` is present but `sessionRef.provider != mode` (the create pipeline's `accepted_session_ref_for_mode` acceptance is deterministic, so a pane that passes preflight is spawned WITH its session), and (ii) the response-envelope success check. Idempotency uses a per-device on-disk restore marker (Task 3), not the live registry.
  - **Connected-browser gate for restore:** `freshell_ws::screenshot::ScreenshotBroker` (constructed at `main.rs:202`, `Clone`) exposes `capable_client_count() -> i64` (`screenshot.rs:95`) counting connected UI clients that advertised `uiScreenshotV1` — the real browser client always does (`src/lib/ws-client.ts:340`). Restore clones the broker into its state and refuses (HTTP 409) when `capable_client_count() > 1` unless `force:true`, so a recovery push can't silently duplicate tabs onto bystander devices. This gate is verifiable in e2e (2 browser contexts → 409; 1 → OK).
  - Restart-respawn-with-identity (Task 10 happy path, Task 7 disruption leg) is already proven end-to-end by the committed-green `codex-terminal-bounce-rust.spec.ts` (reconnect → new terminalId → re-spawned argv contains `resume <sessionId>`; same-session asserted via `harness.getPaneLayout(tabId).content.sessionRef`, argv via the fake-codex `FAKE_CODEX_ARGV_LOG`).

## Scope check

Three deliverables, one plan: they share one subsystem (tabs-sync identity continuity) and Deliverables 2 and 3 consume Deliverable 1's endpoints. Each deliverable is its own independently landable commit series with its own test coverage, executed strictly in order 1 → 2 → 3; Task 10 is whole-system coverage (capture → restart → verify against the restore remediation).

## File structure

| File | Action | Responsibility |
|---|---|---|
| `crates/freshell-ws/src/tabs.rs` | Modify | Snapshot generation persistence (write + prune + read helpers) on the existing `TabsRegistry` |
| `crates/freshell-server/src/main.rs` | Modify | Wire persist dir into `TabsRegistry`; merge the new snapshots router |
| `crates/freshell-server/src/tabs_snapshots.rs` | Create | REST: list/fetch snapshot generations + `POST /api/tabs-sync/restore` |
| `crates/freshell-freshagent/src/terminal_tabs.rs` | Modify | One-line visibility change: `create_terminal_or_content_tab` → `pub` |
| `scripts/restore-tabs.sh` | Create | One-command operator restore (curl+jq wrapper) |
| `scripts/deploy-tab-diff.sh` | Create | Deploy ritual: `capture` / `verify` (GETs only) |
| `test/e2e-browser/specs/snapshot-restore-rust.spec.ts` | Create | Deliverable 1 acceptance round-trip |
| `test/e2e-browser/specs/continuity-smoke.spec.ts` | Create | Deliverable 2: real-CLI 3-minute smoke |
| `test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts` | Create | Deliverable 3 acceptance (pass + loud fail) |
| `test/e2e-browser/helpers/rust-server.ts` | Modify | `FRESHELL_E2E_RUST_SERVER_BIN` override (for the historical-bug proof run) |
| `test/e2e-browser/playwright.config.ts` | Modify | Register new specs; new `continuity-smoke` project outside the default matrix |
| `package.json` | Modify | `smoke:continuity` npm script |
| `port/oracle/DEVIATIONS.md` | Modify | Ledger entry for the additive beyond-legacy surface |
| `docs/plans/2026-07-22-continuity-smoke-evidence.md` | Create | Captured FAIL@`136b9e94~1` / PASS@HEAD outputs |

---

## DELIVERABLE 1 — Snapshot generations + one-command restore

### Task 1: Persist tabs-sync snapshot generations to disk

**Files:**
- Modify: `crates/freshell-ws/src/tabs.rs`
- Modify: `crates/freshell-ws/Cargo.toml` (add `tempfile` under `[dev-dependencies]` if not already present)

**Interfaces:**
- Consumes: existing `TabsRegistry::replace_client_snapshot` (`tabs.rs:107-214`; params are all `&str` + `snapshot_revision: i64` + `mut records: Vec<Value>`; `open_records` is computed at `tabs.rs:129-133` and MOVED into `ClientOpenSnapshot.records` at `tabs.rs:191-198`; the mutex guard `state` has NO enclosing block and lives to end-of-fn; `now = now_ms()` is available; the idempotent same-revision early-return is `tabs.rs:152-162`).
- Directory layout (per-device AND per-client, so concurrent browser clients sharing one `deviceId` never overwrite/prune each other — fixes the "last-writer-wins recovery drops other clients' tabs" defect): `<root>/<enc(deviceId)>/<enc(clientInstanceId)>-<capturedAt:020>-r<revision:012>.json`. `enc()` is INJECTIVE + containment-safe (below), the revision is zero-padded, and the filename carries the client tiebreaker — so two clients at the same revision in the same millisecond target DISTINCT files and `r9` sorts before `r10`.
- Retention (documented, global): at most `MAX_SNAPSHOT_GENERATIONS = 5` files PER (device,client); at most `MAX_SNAPSHOT_DEVICES = 64` device directories (persisting into a new device beyond the cap evicts the least-recently-written device dir first); a generation whose pretty-JSON exceeds `MAX_SNAPSHOT_BYTES = 1_048_576` is skipped (WARN, not written). Bounded total disk ≤ `MAX_SNAPSHOT_DEVICES × (clients seen) × MAX_SNAPSHOT_GENERATIONS × MAX_SNAPSHOT_BYTES`; the per-client fan-out is itself bounded by pruning stale device dirs. This restores the retention protection the module doc (`tabs.rs:16-26`) notes the legacy store had and this port had dropped.
- Produces (later tasks rely on these EXACT names/signatures):
  - `TabsRegistry::with_persist_dir(dir: std::path::PathBuf) -> TabsRegistry`
  - `pub const MAX_SNAPSHOT_GENERATIONS: usize = 5;` / `pub const MAX_SNAPSHOT_DEVICES: usize = 64;` / `pub const MAX_SNAPSHOT_BYTES: usize = 1_048_576;`
  - `pub fn encode_device_id(device_id: &str) -> Option<String>` — injective, containment-safe folder name (keeps `[A-Za-z0-9-]`, escapes every other byte as `_<2-hex>`, and escapes `_` itself as `_5f`; returns `None` for an EMPTY id). Output contains no `.`/`/`, so `..`, `.`, `a/b` can never resolve outside `<root>`; distinct ids never collide (`"dev a/1" -> "dev_20a_2f1"` ≠ `"dev_a_1" -> "dev_5fa_5f1"`).
  - `pub fn list_snapshot_devices(dir: &std::path::Path) -> Vec<String>` — the RAW `deviceId`s (read from each newest generation's stored `deviceId`, NOT the encoded folder name), sorted, deduped.
  - `pub fn list_generations(dir: &std::path::Path, device_id: &str, client_instance_id: &str) -> Vec<std::path::PathBuf>` (one client, newest first).
  - `pub fn read_device_union(dir: &std::path::Path, device_id: &str) -> Option<serde_json::Value>` — the COHERENT device recovery snapshot: the union of each client's NEWEST generation's records, deduped by `tabKey` keeping the highest `revision` (tie: highest `updatedAt`); `capturedAt`/`snapshotRevision` = the max across clients. Used by the read API and restore so no client's tabs are silently omitted.
  - `pub fn read_generation(dir: &std::path::Path, device_id: &str, generation: usize) -> Option<serde_json::Value>` — the Nth-newest DEVICE generation across the merged (all-clients) `capturedAt`-sorted file list (0 = newest single file), for point-in-time rollback. `generation` here is a file index over the merged list; `read_device_union` is what gen-0 recovery uses by default (Task 2/3 wrap both).
  - Generation file JSON: `{deviceId, deviceLabel, clientInstanceId, serverInstanceId, snapshotRevision, capturedAt, records: [...open records, verbatim, post-identity-stamping]}`.

- [ ] **Step 1: Write the failing tests**

Append to the existing `#[cfg(test)] mod tests` in `crates/freshell-ws/src/tabs.rs` (it already defines the `open_record(tab_key, tab_name, updated_at)` helper — reuse it; `panes` defaults to `[]` and can be overwritten):

```rust
fn codex_pane_record(tab_key: &str, session_id: &str, rev_updated: i64) -> Value {
    let mut rec = open_record(tab_key, "codex tab", rev_updated);
    rec["revision"] = json!(rev_updated);
    rec["panes"] = json!([{
        "paneId": "pane-1", "kind": "terminal",
        "payload": {
            "mode": "codex",
            "sessionRef": { "provider": "codex", "sessionId": session_id },
            "initialCwd": "/tmp/proj",
            "liveTerminal": { "terminalId": "term-1", "serverInstanceId": "srv-1" }
        }
    }]);
    rec
}

#[test]
fn persisted_generation_written_with_session_ref_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    reg.replace_client_snapshot("srv-1", "dev a/1", "Device A", "client-a1", 1,
        vec![codex_pane_record("dev-a:tab-1", "abc-123", 1000)]).unwrap();

    let gens = list_generations(dir.path(), "dev a/1", "client-a1");
    assert_eq!(gens.len(), 1);
    let snap = read_device_union(dir.path(), "dev a/1").expect("newest generation");
    assert_eq!(snap["deviceId"], "dev a/1");
    assert_eq!(snap["snapshotRevision"], 1);
    assert_eq!(snap["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"], "abc-123");
    // Identity stamping (envelope wins) survives into the persisted record.
    assert_eq!(snap["records"][0]["deviceId"], "dev a/1");
    // list_snapshot_devices returns the RAW id, not the encoded folder name.
    assert_eq!(list_snapshot_devices(dir.path()), vec!["dev a/1".to_string()]);
}

#[test]
fn encode_device_id_is_injective_containment_safe_and_rejects_empty() {
    // No `.` or `/` can survive -> no traversal / no shared-dir collapse.
    for raw in ["..", ".", "../../etc", "a/b", "", "  "] {
        if let Some(enc) = encode_device_id(raw) {
            assert!(!enc.contains('.') && !enc.contains('/') && !enc.contains('\\'), "{raw} -> {enc}");
        }
    }
    assert_eq!(encode_device_id(""), None, "empty id is rejected (never persisted)");
    // Injective: the reviewer's collision pair must map apart.
    assert_ne!(encode_device_id("dev a/1"), encode_device_id("dev_a_1"));
    // Containment: a traversal id never escapes <root>.
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    reg.replace_client_snapshot("srv", "../../escape", "x", "c1", 1,
        vec![open_record("t:1", "t", 1)]).unwrap();
    // Nothing was written outside the persist root (no stray *.json in its parent).
    let parent = dir.path().parent().unwrap();
    let stray: Vec<_> = std::fs::read_dir(parent).unwrap().flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json")).collect();
    assert!(stray.is_empty(), "traversal id wrote outside the persist root");
    assert_eq!(list_snapshot_devices(dir.path()), vec!["../../escape".to_string()]);
}

#[test]
fn generations_pruned_per_client_padded_ordering() {
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    // Revisions THROUGH 12 (past 9->10) at the SAME capturedAt would collide if
    // the revision weren't zero-padded; the persist path uses `now_ms()` so they
    // differ in practice, but the padding is what guarantees r9 < r10 ordering.
    for rev in 1..=(MAX_SNAPSHOT_GENERATIONS as i64 + 7) {
        reg.replace_client_snapshot("srv-1", "dev", "Dev", "c1", rev,
            vec![open_record("dev:t1", &format!("rev {rev}"), 1000 + rev)]).unwrap();
    }
    let gens = list_generations(dir.path(), "dev", "c1");
    assert_eq!(gens.len(), MAX_SNAPSHOT_GENERATIONS);
    assert_eq!(read_generation(dir.path(), "dev", 0).unwrap()["snapshotRevision"],
        MAX_SNAPSHOT_GENERATIONS as i64 + 7);
    let oldest = read_generation(dir.path(), "dev", MAX_SNAPSHOT_GENERATIONS - 1).unwrap();
    assert_eq!(oldest["snapshotRevision"], (MAX_SNAPSHOT_GENERATIONS as i64 + 7) - 4);
}

#[test]
fn two_clients_same_device_do_not_overwrite_and_union_keeps_both() {
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    // Same device, two concurrent browser clients, DISJOINT tabs.
    reg.replace_client_snapshot("srv", "dev", "Dev", "clientA", 1,
        vec![codex_pane_record("dev:tabA", "sess-A", 1000)]).unwrap();
    reg.replace_client_snapshot("srv", "dev", "Dev", "clientB", 1,
        vec![codex_pane_record("dev:tabB", "sess-B", 1001)]).unwrap();
    // Neither client's generation was clobbered.
    assert_eq!(list_generations(dir.path(), "dev", "clientA").len(), 1);
    assert_eq!(list_generations(dir.path(), "dev", "clientB").len(), 1);
    // The coherent device recovery snapshot contains BOTH clients' tabs.
    let union = read_device_union(dir.path(), "dev").unwrap();
    let keys: Vec<String> = union["records"].as_array().unwrap().iter()
        .map(|r| r["tabKey"].as_str().unwrap().to_string()).collect();
    assert!(keys.contains(&"dev:tabA".to_string()) && keys.contains(&"dev:tabB".to_string()),
        "union dropped a client's tabs: {keys:?}");
}

#[test]
fn union_dedupes_shared_tabkey_keeping_highest_revision() {
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    reg.replace_client_snapshot("srv", "dev", "Dev", "clientA", 7,
        vec![codex_pane_record("dev:shared", "sess-new", 7)]).unwrap();
    reg.replace_client_snapshot("srv", "dev", "Dev", "clientB", 3,
        vec![codex_pane_record("dev:shared", "sess-old", 3)]).unwrap();
    let union = read_device_union(dir.path(), "dev").unwrap();
    let recs = union["records"].as_array().unwrap();
    assert_eq!(recs.len(), 1, "shared tabKey must dedupe");
    assert_eq!(recs[0]["panes"][0]["payload"]["sessionRef"]["sessionId"], "sess-new");
}

#[test]
fn empty_snapshot_does_not_overwrite_last_good_generation() {
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    reg.replace_client_snapshot("srv-1", "dev", "Dev", "c1", 1,
        vec![open_record("dev:t1", "good", 1000)]).unwrap();
    // A wipe/unload push with zero open records must NOT mint a generation.
    reg.replace_client_snapshot("srv-1", "dev", "Dev", "c1", 2, vec![]).unwrap();
    assert_eq!(list_generations(dir.path(), "dev", "c1").len(), 1);
    assert_eq!(read_generation(dir.path(), "dev", 0).unwrap()["snapshotRevision"], 1);
}

#[test]
fn stale_revision_persists_nothing_and_no_dir_persists_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    reg.replace_client_snapshot("srv-1", "dev", "Dev", "c1", 5,
        vec![open_record("dev:t1", "one", 10)]).unwrap();
    assert!(reg.replace_client_snapshot("srv-1", "dev", "Dev", "c1", 4, vec![]).is_err());
    assert_eq!(list_generations(dir.path(), "dev", "c1").len(), 1);

    let plain = TabsRegistry::new(); // no persist dir -> Option path is a no-op
    plain.replace_client_snapshot("srv-1", "dev", "Dev", "c1", 1,
        vec![open_record("dev:t1", "one", 10)]).unwrap();
}

#[test]
fn device_cap_evicts_least_recently_written_device() {
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    // Persist MAX_SNAPSHOT_DEVICES + 1 distinct devices; the oldest dir is evicted.
    for n in 0..=(MAX_SNAPSHOT_DEVICES) {
        let dev = format!("dev-{n:03}");
        reg.replace_client_snapshot("srv", &dev, "D", "c1", 1,
            vec![open_record(&format!("{dev}:t"), "t", 1000 + n as i64)]).unwrap();
    }
    assert_eq!(list_snapshot_devices(dir.path()).len(), MAX_SNAPSHOT_DEVICES);
    // The first device written (dev-000) was evicted; the newest survives.
    assert!(read_device_union(dir.path(), "dev-000").is_none());
    assert!(read_device_union(dir.path(), &format!("dev-{:03}", MAX_SNAPSHOT_DEVICES)).is_some());
}

#[test]
fn oversize_snapshot_is_skipped_not_written() {
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    let big = "x".repeat(MAX_SNAPSHOT_BYTES + 10);
    let mut rec = open_record("dev:t1", "big", 1);
    rec["blob"] = json!(big);
    reg.replace_client_snapshot("srv", "dev", "D", "c1", 1, vec![rec]).unwrap();
    assert!(list_generations(dir.path(), "dev", "c1").is_empty(),
        "oversize generation must be skipped (WARN), not persisted");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-ws encode_device_id` (from the worktree root)
Expected: FAIL to compile — `with_persist_dir`, `list_generations`, `read_generation`, `read_device_union`, `list_snapshot_devices`, `encode_device_id`, and the `MAX_SNAPSHOT_*` consts are not defined. Add `tempfile = "3"` to `crates/freshell-ws/Cargo.toml`'s `[dev-dependencies]` (it is NOT currently present — verified; mirror the version string used by another workspace crate, e.g. `crates/freshell-terminal/Cargo.toml`, if one pins `tempfile`).

- [ ] **Step 3: Implement persistence**

In `crates/freshell-ws/src/tabs.rs` add the imports `use std::path::{Path, PathBuf};` (top of file; `serde_json::{json, Value}` and `Arc`/`Mutex` are already imported, `now_ms()` already exists). `freshell-ws` already depends on `tracing` (Cargo.toml), though `tabs.rs` does not yet `use` it — call it fully-qualified as `tracing::warn!` (no `use` needed).

```rust
/// Max snapshot generations retained per (device, client) (oldest pruned).
pub const MAX_SNAPSHOT_GENERATIONS: usize = 5;
/// Max device directories retained (LRU-by-newest-write eviction beyond this).
pub const MAX_SNAPSHOT_DEVICES: usize = 64;
/// A generation whose pretty-JSON exceeds this is skipped (never written).
pub const MAX_SNAPSHOT_BYTES: usize = 1_048_576;

/// INJECTIVE, containment-safe folder name for a device id. Keeps `[A-Za-z0-9-]`
/// verbatim; escapes `_` as `_5f` and every OTHER byte as `_<2-lower-hex>`. The
/// output can therefore never contain `.`, `/`, or `\`, so `..`, `.`, `a/b`, and
/// absolute paths collapse to a single in-`<root>` child dir; distinct ids never
/// collide (URL-encode-style bijection). Returns `None` for an EMPTY id (an empty
/// id is never persisted — it would otherwise share `<root>` itself).
pub fn encode_device_id(device_id: &str) -> Option<String> {
    if device_id.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(device_id.len());
    for b in device_id.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' => out.push(b as char),
            _ => out.push_str(&format!("_{b:02x}")),
        }
    }
    Some(out)
}

/// The persist root, guaranteed to be a direct child of `<dir>` (belt-and-suspenders
/// containment: `encode_device_id` already strips separators).
fn device_dir_for(dir: &Path, device_id: &str) -> Option<PathBuf> {
    let enc = encode_device_id(device_id)?;
    let device_dir = dir.join(&enc);
    // Containment: the joined path's parent must be exactly `<dir>`.
    if device_dir.parent() != Some(dir) {
        return None;
    }
    Some(device_dir)
}

/// All generation FILES for one client, newest first (filename embeds a
/// zero-padded capturedAt then a zero-padded revision, so lexicographic
/// descending == chronological descending within a client).
pub fn list_generations(dir: &Path, device_id: &str, client_instance_id: &str) -> Vec<PathBuf> {
    let Some(device_dir) = device_dir_for(dir, device_id) else { return Vec::new(); };
    let Some(prefix) = encode_device_id(client_instance_id).map(|c| format!("{c}-")) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&device_dir) else { return Vec::new(); };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .filter(|p| p.file_name().and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with(&prefix)))
        .collect();
    files.sort();
    files.reverse();
    files
}

/// Every generation file for a device across ALL clients, newest first
/// (parsed capturedAt is the sort key so cross-client files interleave correctly).
fn all_generation_files(dir: &Path, device_id: &str) -> Vec<(i64, PathBuf)> {
    let Some(device_dir) = device_dir_for(dir, device_id) else { return Vec::new(); };
    let Ok(entries) = std::fs::read_dir(&device_dir) else { return Vec::new(); };
    let mut files: Vec<(i64, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .filter_map(|p| {
            let text = std::fs::read_to_string(&p).ok()?;
            let v: Value = serde_json::from_str(&text).ok()?;
            Some((v.get("capturedAt").and_then(Value::as_i64).unwrap_or(0), p))
        })
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    files
}

/// The RAW device ids that have at least one persisted generation (read from
/// each device's newest generation's stored `deviceId`, so the API never leaks
/// the encoded folder name). Sorted + deduped.
pub fn list_snapshot_devices(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new(); };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            // read any one generation file in the dir for its raw deviceId
            std::fs::read_dir(e.path()).ok()?.flatten()
                .map(|f| f.path())
                .filter(|p| p.extension().is_some_and(|x| x == "json"))
                .find_map(|p| {
                    let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).ok()?).ok()?;
                    v.get("deviceId").and_then(Value::as_str).map(str::to_string)
                })
        })
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// The Nth-newest DEVICE generation across the merged all-clients file list
/// (0 = newest single file). For point-in-time rollback. None if out of range.
pub fn read_generation(dir: &Path, device_id: &str, generation: usize) -> Option<Value> {
    let files = all_generation_files(dir, device_id);
    let (_, path) = files.get(generation)?;
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// The COHERENT device recovery snapshot: union of each client's NEWEST
/// generation's open records, deduped by `tabKey` keeping the highest
/// `revision` (tie: highest `updatedAt`). Never silently drops a client's tabs.
pub fn read_device_union(dir: &Path, device_id: &str) -> Option<Value> {
    let Some(device_dir) = device_dir_for(dir, device_id) else { return None; };
    let entries = std::fs::read_dir(&device_dir).ok()?;
    // newest generation per client instance
    let mut newest_per_client: HashMap<String, (i64, PathBuf)> = HashMap::new();
    let mut label = Value::Null;
    let mut raw_id = Value::Null;
    for path in entries.flatten().map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json")) {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(v): Result<Value, _> = serde_json::from_str(&text) else { continue };
        let client = v.get("clientInstanceId").and_then(Value::as_str).unwrap_or("").to_string();
        let captured = v.get("capturedAt").and_then(Value::as_i64).unwrap_or(0);
        raw_id = v.get("deviceId").cloned().unwrap_or(Value::Null);
        label = v.get("deviceLabel").cloned().unwrap_or(Value::Null);
        newest_per_client.entry(client)
            .and_modify(|cur| if captured > cur.0 { *cur = (captured, path.clone()); })
            .or_insert((captured, path.clone()));
    }
    if newest_per_client.is_empty() {
        return None;
    }
    // union of records, dedupe by tabKey (highest revision, tie highest updatedAt)
    let mut by_key: HashMap<String, Value> = HashMap::new();
    let mut max_captured = 0i64;
    let mut max_rev = 0i64;
    for (_, path) in newest_per_client.values() {
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        let Ok(snap): Result<Value, _> = serde_json::from_str(&text) else { continue };
        max_captured = max_captured.max(snap.get("capturedAt").and_then(Value::as_i64).unwrap_or(0));
        max_rev = max_rev.max(snap.get("snapshotRevision").and_then(Value::as_i64).unwrap_or(0));
        for rec in snap.get("records").and_then(Value::as_array).cloned().unwrap_or_default() {
            let key = rec.get("tabKey").and_then(Value::as_str).unwrap_or("").to_string();
            let rev = rec.get("revision").and_then(Value::as_i64).unwrap_or(0);
            let upd = rec.get("updatedAt").and_then(Value::as_i64).unwrap_or(0);
            let better = by_key.get(&key).map_or(true, |cur| {
                let crev = cur.get("revision").and_then(Value::as_i64).unwrap_or(0);
                let cupd = cur.get("updatedAt").and_then(Value::as_i64).unwrap_or(0);
                (rev, upd) > (crev, cupd)
            });
            if better { by_key.insert(key, rec); }
        }
    }
    let mut records: Vec<Value> = by_key.into_values().collect();
    records.sort_by_key(|r| r.get("tabKey").and_then(Value::as_str).unwrap_or("").to_string());
    Some(json!({
        "deviceId": raw_id,
        "deviceLabel": label,
        "snapshotRevision": max_rev,
        "capturedAt": max_captured,
        "records": records,
    }))
}
```

Add the field + constructor on `TabsRegistry` (currently `#[derive(Clone, Default)]`
over just `inner` — keep `Default` by making the dir an `Option`):

```rust
#[derive(Clone, Default)]
pub struct TabsRegistry {
    inner: Arc<Mutex<State>>,
    persist_dir: Option<Arc<PathBuf>>,
}

impl TabsRegistry {
    pub fn with_persist_dir(dir: PathBuf) -> Self {
        Self { inner: Arc::default(), persist_dir: Some(Arc::new(dir)) }
    }
    // `new()` unchanged (persist_dir: None via Default).
}
```

In `replace_client_snapshot`, the accept decision is final once past the
stale/idempotent guards (`tabs.rs:147-169`). `open_records` is MOVED into
`ClientOpenSnapshot.records` at `tabs.rs:191-198`, and the mutex guard `state`
has NO enclosing block (it lives to end-of-fn). So capture a CLONE for
persistence BEFORE the move, then DROP the guard before any filesystem I/O.
Insert, immediately before `state.open_snapshots.insert(...)` at `tabs.rs:191`:

```rust
        // Best-effort snapshot generation (never fails the push). Clone BEFORE
        // `open_records` is moved into ClientOpenSnapshot below; skip empty
        // snapshots so a wipe/unload push never overwrites the last-good one.
        let persist_input = self.persist_dir.as_ref().and_then(|dir| {
            if open_records.is_empty() { None }
            else { Some((Arc::clone(dir), open_records.clone())) }
        });
```

Then, AFTER the existing `state.devices.insert(...)` and BEFORE the final
`Ok(PushAck { ... })` (`tabs.rs:207`), release the lock and persist off-lock:

```rust
        drop(state); // release the registry mutex before filesystem I/O
        if let Some((dir, records)) = persist_input {
            self.persist_generation(
                &dir, server_instance_id, device_id, device_label,
                client_instance_id, snapshot_revision, &records, now,
            );
        }
```

(`now`, `server_instance_id`, `device_id`, `device_label`, `client_instance_id`,
`snapshot_revision` are all still in scope — none were moved; only `key` and
`open_records`/`closed_records` were.)

```rust
    /// Write `<root>/<enc(device)>/<enc(client)>-<capturedAt:020>-r<rev:012>.json`
    /// atomically (tmp + rename), enforce the device cap (LRU-by-newest-write
    /// eviction) and per-client generation cap, and skip oversize snapshots.
    /// Best-effort: every failure is a WARN, never an Err.
    #[allow(clippy::too_many_arguments)]
    fn persist_generation(
        &self,
        dir: &Path,
        server_instance_id: &str,
        device_id: &str,
        device_label: &str,
        client_instance_id: &str,
        snapshot_revision: i64,
        open_records: &[Value],
        captured_at: i64,
    ) {
        let write = || -> std::io::Result<()> {
            let Some(device_dir) = device_dir_for(dir, device_id) else {
                return Ok(()); // empty/uncontainable device id -> never persist
            };
            let Some(client_enc) = encode_device_id(client_instance_id) else { return Ok(()); };
            let snapshot = json!({
                "deviceId": device_id,
                "deviceLabel": device_label,
                "clientInstanceId": client_instance_id,
                "serverInstanceId": server_instance_id,
                "snapshotRevision": snapshot_revision,
                "capturedAt": captured_at,
                "records": open_records,
            });
            let bytes = serde_json::to_vec_pretty(&snapshot)?;
            if bytes.len() > MAX_SNAPSHOT_BYTES {
                tracing::warn!(target: "freshell_ws::tabs", device_id = %device_id,
                    bytes = bytes.len(), "tabs_snapshot_skipped_oversize");
                return Ok(());
            }
            // Device cap: if this is a NEW device dir and we're at the cap, evict
            // the least-recently-written device (oldest max-capturedAt) first.
            enforce_device_cap(dir, &device_dir)?;
            std::fs::create_dir_all(&device_dir)?;
            let name = format!("{client_enc}-{captured_at:020}-r{snapshot_revision:012}.json");
            let tmp = device_dir.join(format!(".{name}.tmp"));
            std::fs::write(&tmp, &bytes)?;
            std::fs::rename(&tmp, device_dir.join(&name))?;
            // Per-client prune: keep newest MAX_SNAPSHOT_GENERATIONS for THIS client.
            let mut client_files: Vec<PathBuf> = std::fs::read_dir(&device_dir)?
                .flatten().map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| e == "json"))
                .filter(|p| p.file_name().and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(&format!("{client_enc}-"))))
                .collect();
            client_files.sort();
            while client_files.len() > MAX_SNAPSHOT_GENERATIONS {
                let _ = std::fs::remove_file(client_files.remove(0));
            }
            Ok(())
        };
        if let Err(err) = write() {
            tracing::warn!(target: "freshell_ws::tabs", device_id = %device_id,
                error = %err, "tabs_snapshot_persist_failed: generation not written");
        }
    }
```

Free helper (module scope):

```rust
/// Enforce MAX_SNAPSHOT_DEVICES. If `target_dir` is NEW and the root is already
/// at the cap, remove the device dir with the OLDEST newest-generation capturedAt.
fn enforce_device_cap(root: &Path, target_dir: &Path) -> std::io::Result<()> {
    if target_dir.exists() {
        return Ok(());
    }
    let Ok(entries) = std::fs::read_dir(root) else { return Ok(()); };
    let mut dirs: Vec<(i64, PathBuf)> = entries.flatten()
        .map(|e| e.path()).filter(|p| p.is_dir())
        .map(|p| {
            let newest = std::fs::read_dir(&p).into_iter().flatten().flatten()
                .map(|f| f.path())
                .filter(|f| f.extension().is_some_and(|x| x == "json"))
                .filter_map(|f| serde_json::from_str::<Value>(&std::fs::read_to_string(&f).ok()?)
                    .ok()?.get("capturedAt").and_then(Value::as_i64))
                .max().unwrap_or(0);
            (newest, p)
        })
        .collect();
    while dirs.len() >= MAX_SNAPSHOT_DEVICES {
        dirs.sort_by_key(|(c, _)| *c);
        let (_, victim) = dirs.remove(0);
        let _ = std::fs::remove_dir_all(victim);
    }
    Ok(())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws`
Expected: PASS (all new tests + every pre-existing `tabs.rs` test unchanged).

- [ ] **Step 5: Wire the persist dir in `main.rs`**

In `crates/freshell-server/src/main.rs` around line 272-274, replace
`let tabs = freshell_ws::tabs::TabsRegistry::new();` with construction from
the SAME home resolution the settings store uses just above it in `main()`
(main.rs resolves `FRESHELL_HOME`/`HOME` into a home path near line 120 —
reuse that binding; a `None` home keeps the in-memory-only registry):

```rust
    // Tabs registry now persists rolling snapshot generations under
    // `<home>/.freshell/tabs-snapshots/<deviceId>/` (last 5 per device) so a
    // device's tabs can be rebuilt after client-state loss (continuity trio,
    // docs/plans/2026-07-22-continuity-safety-trio.md).
    let tabs = match &home {
        Some(home) => freshell_ws::tabs::TabsRegistry::with_persist_dir(
            home.join(".freshell").join("tabs-snapshots"),
        ),
        None => freshell_ws::tabs::TabsRegistry::new(),
    };
```

(Adapt the exact `home` variable name/type to what `main.rs` already has — do
NOT introduce a second, divergent home resolution.)

- [ ] **Step 6: Verify build + full crate tests**

Run: `cargo test -p freshell-ws -p freshell-server && cargo build --release -p freshell-server`
Expected: green; release binary rebuilt.
Then run `rust_check`/`cargo fmt --all -- --check` and `cargo clippy -p freshell-ws -p freshell-server` — clean on touched files.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-ws/src/tabs.rs crates/freshell-ws/Cargo.toml crates/freshell-server/src/main.rs
git commit -m "feat(tabs-sync): persist rolling per-device snapshot generations under ~/.freshell

Last 5 generations per device, atomic writes, empty-push guard so a wipe
never overwrites the last-good snapshot. Continuity trio deliverable 1/3.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 2: Snapshot read REST endpoints

**Files:**
- Create: `crates/freshell-server/src/tabs_snapshots.rs`
- Modify: `crates/freshell-server/src/main.rs` (module decl + router merge)

**Interfaces:**
- Consumes: `freshell_ws::tabs::{list_snapshot_devices, read_generation, read_device_union}` (Task 1); `crate::boot::is_authed` (`pub(crate)`, `boot.rs:686`).
- Produces:
  - `GET /api/tabs-sync/snapshots` → `{"devices":[{"deviceId":"<raw id>","recordCount":<union count>,"capturedAt":<union max>,"deviceLabel":"...","generations":[{"generation":0,"capturedAt":...,"snapshotRevision":...,"recordCount":...,"deviceLabel":"..."}]}]}`. `deviceId` is the RAW id (via `list_snapshot_devices`); top-level `recordCount`/`capturedAt` reflect the COHERENT union (`read_device_union`) so the operator sees the true recovery view even with multiple clients; `generations[]` is the merged all-clients point-in-time list (newest-first via `read_generation(dir, device, n)` walked until `None`).
  - `GET /api/tabs-sync/snapshots/{deviceId}` (no `generation` param) → the UNION recovery snapshot (`read_device_union`); `?generation=N` → the Nth-newest point-in-time file (`read_generation`); 404 when absent.
  - `pub struct TabsSnapshotsState { pub auth_token: std::sync::Arc<String>, pub snapshots_dir: Option<std::path::PathBuf>, pub fresh_agent: freshell_freshagent::FreshAgentState, pub screenshots: freshell_ws::screenshot::ScreenshotBroker }` — `fresh_agent` drives Task 3's restore create pipeline; `screenshots` is Task 3's connected-browser gate. Construct all fields now so the router is built once.
  - `pub fn router(state: TabsSnapshotsState) -> axum::Router`

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-server/src/tabs_snapshots.rs` with the module skeleton + a `#[cfg(test)] mod tests` first (mirror the axum `oneshot` test pattern from `crates/freshell-server/src/terminals.rs:1090-1110` / `sessions.rs:370-380`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use serde_json::json;
    use tower::ServiceExt;

    const TOKEN: &str = "test-token";

    fn codex_record(session_id: &str, rev: i64) -> serde_json::Value {
        json!({
            "tabKey": "dev-1:tab-1", "tabId": "tab-1", "tabName": "codex",
            "status": "open", "revision": rev, "updatedAt": 1000 + rev, "paneCount": 1,
            "panes": [{ "paneId": "p1", "kind": "terminal", "payload": {
                "mode": "codex",
                "sessionRef": { "provider": "codex", "sessionId": session_id },
                "initialCwd": "/tmp"
            }}]
        })
    }

    // Seed real generations through the registry so the on-disk (encoded,
    // per-client) layout matches what the read helpers expect.
    fn seed(dir: &std::path::Path, device: &str, client: &str, rev: i64, session_id: &str) {
        let reg = freshell_ws::tabs::TabsRegistry::with_persist_dir(dir.to_path_buf());
        reg.replace_client_snapshot("srv", device, "Dev One", client, rev,
            vec![codex_record(session_id, rev)]).unwrap();
    }

    fn fresh_agent_for_tests() -> freshell_freshagent::FreshAgentState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        freshell_freshagent::FreshAgentState::new(
            std::sync::Arc::new(TOKEN.to_string()), std::sync::Arc::new(tx))
            .with_terminal_registry(freshell_terminal::TerminalRegistry::new())
    }

    fn test_state(dir: &std::path::Path) -> TabsSnapshotsState {
        TabsSnapshotsState {
            auth_token: std::sync::Arc::new(TOKEN.to_string()),
            snapshots_dir: Some(dir.to_path_buf()),
            fresh_agent: fresh_agent_for_tests(),
            screenshots: freshell_ws::screenshot::ScreenshotBroker::new(
                std::sync::Arc::new(tokio::sync::broadcast::channel::<String>(64).0)),
        }
    }

    async fn get(router: axum::Router, uri: &str, auth: bool) -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder().method("GET").uri(uri);
        if auth { req = req.header("x-auth-token", TOKEN); }
        let resp = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
    }

    #[tokio::test]
    async fn snapshots_list_requires_auth_and_lists_devices_with_generations() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), "dev-1", "c1", 1, "s-old");
        seed(dir.path(), "dev-1", "c1", 2, "s-new");
        let (status, _) = get(router(test_state(dir.path())), "/api/tabs-sync/snapshots", false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, body) = get(router(test_state(dir.path())), "/api/tabs-sync/snapshots", true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["devices"][0]["deviceId"], "dev-1"); // RAW id, not encoded
        let gens = body["devices"][0]["generations"].as_array().unwrap();
        assert_eq!(gens.len(), 2);
        assert_eq!(gens[0]["generation"], 0);
        assert_eq!(gens[0]["snapshotRevision"], 2); // newest first
        assert_eq!(body["devices"][0]["recordCount"], 1); // union view
    }

    #[tokio::test]
    async fn snapshot_fetch_union_and_nth_and_404() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), "dev-1", "c1", 1, "s-old");
        seed(dir.path(), "dev-1", "c1", 2, "s-new");
        // no generation param -> coherent union (newest per client)
        let (status, body) =
            get(router(test_state(dir.path())), "/api/tabs-sync/snapshots/dev-1", true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"], "s-new");
        // generation=1 -> the older point-in-time file
        let (_, body) =
            get(router(test_state(dir.path())), "/api/tabs-sync/snapshots/dev-1?generation=1", true).await;
        assert_eq!(body["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"], "s-old");
        let (status, _) =
            get(router(test_state(dir.path())), "/api/tabs-sync/snapshots/nope", true).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
```

The `FreshAgentState`/`ScreenshotBroker` test constructors above are the REAL
`pub` constructors (verified `terminal_tabs.rs:1394-1402`, `screenshot.rs:67`);
no `new_for_tests` helper is added. `freshell-server` already depends on
`freshell-terminal`, `freshell-ws`, and `tokio` (with the `sync` feature), so
these compile in `freshell-server`'s test target.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-server tabs_snapshots`
Expected: FAIL to compile (`tabs_snapshots` module/`router`/`TabsSnapshotsState` missing). Add `mod tabs_snapshots;` to `main.rs` first so the module participates in the build.

- [ ] **Step 3: Implement the read endpoints**

`crates/freshell-server/src/tabs_snapshots.rs`:

```rust
//! Tabs-sync snapshot REST surface (continuity trio,
//! docs/plans/2026-07-22-continuity-safety-trio.md). ADDITIVE, beyond-legacy:
//! the legacy server has no on-disk snapshot generations at all
//! (see port/oracle/DEVIATIONS.md DEV entry). Read endpoints serve the
//! generations Task 1 persists; POST /api/tabs-sync/restore (Task 3) rebuilds
//! tabs by driving the SAME `POST /api/tabs` create pipeline.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{json, Value};

use crate::boot::is_authed; // pub(crate) in boot.rs:686 — same crate, no copy

#[derive(Clone)]
pub struct TabsSnapshotsState {
    pub auth_token: Arc<String>,
    pub snapshots_dir: Option<PathBuf>,
    pub fresh_agent: freshell_freshagent::FreshAgentState,
    pub screenshots: freshell_ws::screenshot::ScreenshotBroker,
}

pub fn router(state: TabsSnapshotsState) -> Router {
    Router::new()
        .route("/api/tabs-sync/snapshots", get(list_snapshots))
        .route("/api/tabs-sync/snapshots/{device_id}", get(get_snapshot))
        .with_state(state)
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Unauthorized" }))).into_response()
}

async fn list_snapshots(
    State(state): State<TabsSnapshotsState>,
    headers: HeaderMap,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(dir) = &state.snapshots_dir else {
        return Json(json!({ "devices": [] })).into_response();
    };
    let devices: Vec<Value> = freshell_ws::tabs::list_snapshot_devices(dir)
        .into_iter()
        .map(|device| {
            // Merged all-clients point-in-time generation index (newest first).
            let mut generations = Vec::new();
            let mut n = 0usize;
            while let Some(snap) = freshell_ws::tabs::read_generation(dir, &device, n) {
                generations.push(json!({
                    "generation": n,
                    "capturedAt": snap.get("capturedAt").cloned().unwrap_or(Value::Null),
                    "snapshotRevision": snap.get("snapshotRevision").cloned().unwrap_or(Value::Null),
                    "deviceLabel": snap.get("deviceLabel").cloned().unwrap_or(Value::Null),
                    "recordCount": snap.get("records").and_then(Value::as_array).map(|r| r.len()).unwrap_or(0),
                }));
                n += 1;
            }
            // Coherent union recovery view (across clients) for the summary fields.
            let union = freshell_ws::tabs::read_device_union(dir, &device).unwrap_or(Value::Null);
            json!({
                "deviceId": device,
                "deviceLabel": union.get("deviceLabel").cloned().unwrap_or(Value::Null),
                "recordCount": union.get("records").and_then(Value::as_array).map(|r| r.len()).unwrap_or(0),
                "capturedAt": union.get("capturedAt").cloned().unwrap_or(Value::Null),
                "generations": generations,
            })
        })
        .collect();
    Json(json!({ "devices": devices })).into_response()
}

async fn get_snapshot(
    State(state): State<TabsSnapshotsState>,
    AxumPath(device_id): AxumPath<String>,
    headers: HeaderMap,
    Query(params): Query<Vec<(String, String)>>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(dir) = state.snapshots_dir.as_deref() else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Snapshot not found" }))).into_response();
    };
    // No `generation` param -> the coherent device union; `generation=N` -> the
    // Nth-newest point-in-time file.
    let snap = match params.iter().find(|(k, _)| k == "generation") {
        Some((_, v)) => v.parse::<usize>().ok()
            .and_then(|g| freshell_ws::tabs::read_generation(dir, &device_id, g)),
        None => freshell_ws::tabs::read_device_union(dir, &device_id),
    };
    match snap {
        Some(snap) => Json(snap).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "Snapshot not found" }))).into_response(),
    }
}
```

**Auth note:** `is_authed` is `pub(crate)` in `boot.rs:686` — `use crate::boot::is_authed;` (same crate). If not reachable, raise its visibility to `pub(crate)`; do NOT copy the function.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server tabs_snapshots`
Expected: PASS.

- [ ] **Step 5: Merge the router in `main.rs`**

In the `.merge(...)` chain (`main.rs:620-663`), after `boot::router(...)`:

```rust
        .merge(tabs_snapshots::router(tabs_snapshots::TabsSnapshotsState {
            auth_token: Arc::clone(&auth_token),
            snapshots_dir: home.as_ref().map(|h| h.join(".freshell").join("tabs-snapshots")),
            fresh_agent: fresh_agent_state.clone(),
            screenshots: screenshots.clone(),
        }))
```

(Adapt `auth_token`/`home`/`fresh_agent_state`/`screenshots` to the exact local
bindings `main.rs` already passes to neighboring routers — `fresh_agent_state`
is used at `main.rs:621`, `screenshots` is the `ScreenshotBroker` from
`main.rs:202`. Must be merged AFTER those bindings exist. The `snapshots_dir`
here MUST match the `tabs-snapshots` dir Task 1 wired into the `TabsRegistry`.)

- [ ] **Step 6: Full check + commit**

Run: `cargo test -p freshell-server && cargo clippy -p freshell-server && cargo fmt --all -- --check`

```bash
git add crates/freshell-server/src/tabs_snapshots.rs crates/freshell-server/src/main.rs
git commit -m "feat(tabs-sync): REST read surface for persisted snapshot generations

GET /api/tabs-sync/snapshots (per-device generation index) and
GET /api/tabs-sync/snapshots/{deviceId}?generation=N (0 = newest).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 3: `POST /api/tabs-sync/restore` — rebuild tabs from a snapshot

**Files:**
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (visibility: `pub(crate) async fn create_terminal_or_content_tab` → `pub async fn`, with a doc comment naming this consumer)
- Modify: `crates/freshell-server/src/tabs_snapshots.rs` (add the restore route + handler)

**Interfaces:**
- Consumes: `freshell_freshagent::terminal_tabs::create_terminal_or_content_tab(state: FreshAgentState, body: Value) -> Response` — change ONLY that fn's visibility `pub(crate)` → `pub` (`pub mod terminal_tabs` is already public, `lib.rs:44`, so NO re-export is added), and call it by FULL PATH `freshell_freshagent::terminal_tabs::create_terminal_or_content_tab(...)`. Also `read_device_union`/`read_generation` (Task 1) and `state.screenshots.capable_client_count()` (the connected-browser gate).
- Produces: `POST /api/tabs-sync/restore`, body `{"deviceId":"...", "generation":<usize?>, "dryRun":<bool?>, "force":<bool?>}` →
  - `400` when `deviceId` missing/empty.
  - `409 {"error":"restore refused: N browser clients connected; pass force to override","connectedClients":N}` when `capable_client_count() > 1` and not `force` and not `dryRun` (guards against duplicating tabs onto bystander devices — the create pipeline broadcasts `ui.command{tab.create}` to ALL clients, `lib.rs:305-311`).
  - `404` when no such snapshot for `deviceId`.
  - `200 {"deviceId","generation","sourceCapturedAt","broadcastScope":"all-connected-clients","connectedClients":N,"restored":[{"tabKey","paneId","kind","request"?,"tabId"?,"terminalId"?}],"skipped":[{"tabKey","paneId","kind","reason"}],"failed":[{"tabKey","paneId","kind","status"?,"error"?,"reason"?}]}`.
- Snapshot source: no `generation` param → `read_device_union` (coherent, all-clients); `generation=N` → `read_generation` (point-in-time). `sourceCapturedAt` echoes the chosen snapshot's `capturedAt`.
- Restore semantics (documented in the module doc AND the response envelope):
  - Every OPEN record's pane becomes ONE new tab via a `POST /api/tabs`-equivalent body driven through `create_terminal_or_content_tab` (multi-pane tabs flatten to one tab per pane — the layout tree is client-owned, not restorable server-side).
  - **Identity-loss guard (preflight, BEFORE spawning):** for `kind:"terminal"`, if the snapshot pane carries a `payload.sessionRef`, it MUST have `sessionRef.provider == payload.mode`; otherwise the pane is `failed` with `reason:"session-identity-mismatch"` and is NOT spawned. This prevents the create pipeline from silently minting a FRESH identity-less session and labelling it "restored" (the pipeline's `accepted_session_ref_for_mode` acceptance is deterministic, so a pane that PASSES preflight is guaranteed to spawn with its captured session). A terminal pane with NO `sessionRef` has no identity to lose and is restored as-is.
  - **Result verification (not HTTP-200-trust):** the create response envelope is unwrapped — a pane counts as `restored` only when the create returned success AND `resp_body["status"] == "ok"`; ids are read from `resp_body["data"]` (`{tabId, paneId?, terminalId?}`); any non-ok create is `failed` with the HTTP `status` + `error` body.
  - **Idempotency + partial-failure:** a real (non-dryRun) restore writes a per-device marker `<device_dir>/last-restore.marker` recording `{generation, at, restoredTabKeys:[...]}` (only SUCCEEDED tabKeys). On a rerun for the SAME `deviceId`+`generation` WITHOUT `force`, panes whose `tabKey` is already in the marker are `skipped` with `reason:"already-restored"` and NOT recreated; failed/absent tabKeys are retried. `force:true` ignores the marker. This makes restore safe to rerun after a partial failure or a lost HTTP response (no duplicated earlier successes). The `.marker` extension is chosen so it is invisible to `list_generations`/prune (which filter `*.json`).
  - `kind:"terminal"` create body → `{"mode": payload.mode || "shell", "cwd": payload.initialCwd (when a string), "name": tabName, "sessionRef": payload.sessionRef (when an object)}`.
  - `kind:"browser"` → `{"browser": payload.url, "name": tabName}`; `kind:"editor"` → `{"editor": payload.filePath, "name": tabName}`.
  - `kind:"fresh-agent"` and any other kind → `skipped` with `reason:"unsupported-kind"` (the REST create pipeline has no resume shape for agent chat panes — `create_tab` only accepts `agent:"opencode"` fresh creates, `lib.rs:1158-1171`). REPORTED loudly, never silent.

- [ ] **Step 1: Write the failing tests**

Append to `tabs_snapshots.rs` tests (the shell terminal spawn is real — the
existing `terminal_tabs.rs` tests already spawn `mode:"shell"` PTYs in-crate,
`terminal_tabs.rs:1525-1545`, so this is an established test pattern; the
`FreshAgentState` used must have the terminal registry wired the same way
those tests do — reuse their constructor):

```rust
    async fn post(router: axum::Router, uri: &str, body: serde_json::Value, auth: bool) -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder().method("POST").uri(uri).header("content-type", "application/json");
        if auth { req = req.header("x-auth-token", TOKEN); }
        let resp = router.oneshot(req.body(Body::from(body.to_string())).unwrap()).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
    }

    // Seed a real generation (encoded layout) via the registry.
    fn seed_records(dir: &std::path::Path, device: &str, client: &str, rev: i64, records: Vec<Value>) {
        let reg = freshell_ws::tabs::TabsRegistry::with_persist_dir(dir.to_path_buf());
        reg.replace_client_snapshot("srv", device, "Dev One", client, rev, records).unwrap();
    }

    fn rec(tab: &str, kind: &str, payload: Value) -> Value {
        json!({ "tabKey": format!("dev-1:{tab}"), "tabId": tab, "tabName": tab, "status": "open",
                "revision": 1, "updatedAt": 2000, "paneCount": 1,
                "panes": [{ "paneId": format!("p-{tab}"), "kind": kind, "payload": payload }] })
    }

    fn mixed_records() -> Vec<Value> {
        vec![
            rec("t1", "terminal", json!({ "mode": "shell", "initialCwd": "/tmp" })),
            rec("t2", "browser", json!({ "url": "https://example.com" })),
            rec("t3", "fresh-agent", json!({ "provider": "claude",
                "sessionRef": { "provider": "claude", "sessionId": "x" } })),
        ]
    }

    #[tokio::test]
    async fn restore_rebuilds_supported_panes_and_reports_skips() {
        let dir = tempfile::tempdir().unwrap();
        seed_records(dir.path(), "dev-1", "c1", 3, mixed_records());
        let (status, body) = post(router(test_state(dir.path())), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["broadcastScope"], "all-connected-clients");
        let restored = body["restored"].as_array().unwrap();
        assert_eq!(restored.len(), 2, "shell terminal + browser restored: {body}");
        // ids come from the create envelope's `.data` (terminalId for terminal only).
        assert!(restored.iter().any(|r| r["kind"] == "terminal" && r["terminalId"].is_string()));
        assert!(restored.iter().any(|r| r["kind"] == "browser" && r["tabId"].is_string()));
        let skipped = body["skipped"].as_array().unwrap();
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0]["reason"], "unsupported-kind");
        assert_eq!(body["failed"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn restore_rejects_provider_mismatch_before_spawning() {
        let dir = tempfile::tempdir().unwrap();
        // codex mode but a CLAUDE sessionRef -> identity would be lost if spawned.
        seed_records(dir.path(), "dev-1", "c1", 1, vec![
            rec("t1", "terminal", json!({ "mode": "codex",
                "sessionRef": { "provider": "claude", "sessionId": "z" } }))]);
        let (status, body) = post(router(test_state(dir.path())), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["restored"].as_array().unwrap().len(), 0);
        assert_eq!(body["failed"][0]["reason"], "session-identity-mismatch");
    }

    #[tokio::test]
    async fn restore_is_idempotent_across_reruns() {
        let dir = tempfile::tempdir().unwrap();
        seed_records(dir.path(), "dev-1", "c1", 1, vec![
            rec("t1", "terminal", json!({ "mode": "shell" }))]);
        let first = post(router(test_state(dir.path())), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true).await.1;
        assert_eq!(first["restored"].as_array().unwrap().len(), 1);
        // rerun same device+generation -> already-restored skip, nothing new created.
        let second = post(router(test_state(dir.path())), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true).await.1;
        assert_eq!(second["restored"].as_array().unwrap().len(), 0);
        assert_eq!(second["skipped"][0]["reason"], "already-restored");
        // force overrides the marker.
        let forced = post(router(test_state(dir.path())), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1", "force": true }), true).await.1;
        assert_eq!(forced["restored"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn restore_refuses_when_multiple_browsers_connected() {
        let dir = tempfile::tempdir().unwrap();
        seed_records(dir.path(), "dev-1", "c1", 1, vec![
            rec("t1", "terminal", json!({ "mode": "shell" }))]);
        let state = test_state(dir.path());
        state.screenshots.add_capable_client();
        state.screenshots.add_capable_client(); // 2 connected browsers
        let (status, body) = post(router(state.clone()), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["connectedClients"], 2);
        // force overrides the gate.
        let (status, _) = post(router(state), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1", "force": true }), true).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn restore_dry_run_creates_nothing_and_404_on_missing_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        seed_records(dir.path(), "dev-1", "c1", 3, mixed_records());
        let (status, body) = post(router(test_state(dir.path())), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1", "dryRun": true }), true).await;
        assert_eq!(status, StatusCode::OK);
        // dryRun: plan reported under "restored" with the would-be request, no tabId.
        assert_eq!(body["restored"].as_array().unwrap().len(), 2);
        assert!(body["restored"][0]["tabId"].is_null());
        // dryRun writes no marker (a later real restore still restores).
        let (status, _) = post(router(test_state(dir.path())), "/api/tabs-sync/restore",
            json!({ "deviceId": "ghost" }), true).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
```

(`ScreenshotBroker::add_capable_client` is `pub`, `screenshot.rs:79`; the broker
is `Clone`/`Arc`-backed so mutating `state.screenshots` before building the
router is visible to the handler.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-server tabs_snapshots`
Expected: FAIL (route not registered → 404 / handler missing → compile error).

- [ ] **Step 3: Implement restore**

In `terminal_tabs.rs`, change the visibility (and ONLY the visibility) of
`create_terminal_or_content_tab` (`terminal_tabs.rs:189`) from `pub(crate)` to
`pub`, extending its doc comment: "Also driven in-process by `freshell-server`'s
`POST /api/tabs-sync/restore` (continuity trio) — restore MUST reuse this exact
pipeline because it is the path that stamps session identity." `pub mod
terminal_tabs` is ALREADY public (`lib.rs:44`) with no crate-root re-export, so
callers use the full path `freshell_freshagent::terminal_tabs::create_terminal_or_content_tab`.
Do NOT add a `pub use` re-export.

In `tabs_snapshots.rs` add to `router()`:

```rust
        .route("/api/tabs-sync/restore", axum::routing::post(restore_tabs))
```

Handler + helpers:

```rust
const RESTORE_MARKER: &str = "last-restore.marker"; // .marker ext -> invisible to *.json listing

/// Map one snapshot pane to its `POST /api/tabs` body, or Err(reason). Reasons
/// starting a FAIL (identity/url/path) vs a SKIP (unsupported-kind) are
/// classified by the caller. Terminal panes carrying a sessionRef whose
/// provider != mode are rejected HERE (before spawning) so the create pipeline
/// can never mint a fresh identity-less session and call it restored.
fn pane_to_create_body(tab_name: Option<&Value>, pane: &Value) -> Result<Value, &'static str> {
    let payload = pane.get("payload").cloned().unwrap_or_else(|| json!({}));
    let kind = pane.get("kind").and_then(Value::as_str).unwrap_or("");
    let name = tab_name.cloned().unwrap_or(Value::Null);
    match kind {
        "terminal" => {
            let mode = payload.get("mode").and_then(Value::as_str).unwrap_or("shell");
            let mut b = json!({ "mode": mode, "name": name });
            if let Some(cwd) = payload.get("initialCwd").filter(|v| v.is_string()) {
                b["cwd"] = cwd.clone();
            }
            if let Some(sref) = payload.get("sessionRef").filter(|v| v.is_object()) {
                // Identity-loss guard: a captured session MUST match its mode.
                if sref.get("provider").and_then(Value::as_str) != Some(mode) {
                    return Err("session-identity-mismatch");
                }
                b["sessionRef"] = sref.clone();
            }
            Ok(b)
        }
        "browser" => match payload.get("url").and_then(Value::as_str) {
            Some(url) => Ok(json!({ "browser": url, "name": name })),
            None => Err("missing-url"),
        },
        "editor" => match payload.get("filePath").and_then(Value::as_str) {
            Some(fp) => Ok(json!({ "editor": fp, "name": name })),
            None => Err("missing-filePath"),
        },
        _ => Err("unsupported-kind"),
    }
}

fn read_marker(device_dir: &std::path::Path, generation: usize) -> std::collections::HashSet<String> {
    let path = device_dir.join(RESTORE_MARKER);
    let Ok(v) = std::fs::read_to_string(&path).map(|s| serde_json::from_str::<Value>(&s)) else {
        return Default::default();
    };
    let Ok(v) = v else { return Default::default(); };
    if v.get("generation").and_then(Value::as_u64) != Some(generation as u64) {
        return Default::default(); // marker is for a different generation
    }
    v.get("restoredTabKeys").and_then(Value::as_array).map(|a| {
        a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()
    }).unwrap_or_default()
}

fn write_marker(device_dir: &std::path::Path, generation: usize, tab_keys: &std::collections::HashSet<String>, at: i64) {
    let _ = std::fs::create_dir_all(device_dir);
    let keys: Vec<&String> = tab_keys.iter().collect();
    let _ = std::fs::write(device_dir.join(RESTORE_MARKER),
        serde_json::to_vec_pretty(&json!({
            "generation": generation, "at": at, "restoredTabKeys": keys
        })).unwrap_or_default());
}

async fn restore_tabs(
    State(state): State<TabsSnapshotsState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let device_id = match body.get("deviceId").and_then(Value::as_str) {
        Some(d) if !d.is_empty() => d,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "deviceId is required" }))).into_response(),
    };
    let dry_run = body.get("dryRun").and_then(Value::as_bool).unwrap_or(false);
    let force = body.get("force").and_then(Value::as_bool).unwrap_or(false);
    let connected = state.screenshots.capable_client_count();

    // Broadcast gate: the create pipeline broadcasts tab.create to ALL clients,
    // so refuse to duplicate onto bystander browsers unless forced (dry runs are
    // always allowed -- they create nothing).
    if !dry_run && !force && connected > 1 {
        return (StatusCode::CONFLICT, Json(json!({
            "error": format!("restore refused: {connected} browser clients connected; pass force to override"),
            "connectedClients": connected,
        }))).into_response();
    }

    let Some(dir) = state.snapshots_dir.clone() else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Snapshot not found" }))).into_response();
    };
    // No generation param -> the coherent device union; generation=N -> point-in-time.
    let (generation, snap) = match body.get("generation").and_then(Value::as_u64) {
        Some(g) => (g as usize, freshell_ws::tabs::read_generation(&dir, device_id, g as usize)),
        None => (0usize, freshell_ws::tabs::read_device_union(&dir, device_id)),
    };
    let Some(snap) = snap else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Snapshot not found" }))).into_response();
    };

    let device_dir = state.snapshots_dir.as_deref()
        .and_then(|d| freshell_ws::tabs::encode_device_id(device_id).map(|e| d.join(e)));
    let already: std::collections::HashSet<String> = match (&device_dir, force, dry_run) {
        (Some(dd), false, false) => read_marker(dd, generation),
        _ => Default::default(),
    };

    let mut restored = Vec::new();
    let mut skipped = Vec::new();
    let mut failed = Vec::new();
    let mut newly_restored: std::collections::HashSet<String> = already.clone();
    let records = snap.get("records").and_then(Value::as_array).cloned().unwrap_or_default();
    for record in &records {
        if record.get("status").and_then(Value::as_str) != Some("open") { continue; }
        let tab_key = record.get("tabKey").cloned().unwrap_or(Value::Null);
        let tab_key_str = tab_key.as_str().unwrap_or("").to_string();
        let tab_name = record.get("tabName");
        for pane in record.get("panes").and_then(Value::as_array).cloned().unwrap_or_default().iter() {
            let pane_id = pane.get("paneId").cloned().unwrap_or(Value::Null);
            let kind = pane.get("kind").cloned().unwrap_or(Value::Null);
            // Idempotency: a tabKey already restored from THIS generation is skipped.
            if !dry_run && !force && already.contains(&tab_key_str) {
                skipped.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "reason": "already-restored" }));
                continue;
            }
            match pane_to_create_body(tab_name, pane) {
                Err("unsupported-kind") => skipped.push(json!({ "tabKey": tab_key,
                    "paneId": pane_id, "kind": kind, "reason": "unsupported-kind" })),
                Err(reason) => failed.push(json!({ "tabKey": tab_key, "paneId": pane_id,
                    "kind": kind, "reason": reason })),
                Ok(create_body) if dry_run => restored.push(json!({ "tabKey": tab_key,
                    "paneId": pane_id, "kind": kind, "request": create_body, "tabId": Value::Null })),
                Ok(create_body) => {
                    let resp = freshell_freshagent::terminal_tabs::create_terminal_or_content_tab(
                        state.fresh_agent.clone(), create_body.clone()).await;
                    let status = resp.status();
                    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap_or_default();
                    let resp_body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                    // Success requires HTTP 2xx AND the envelope status "ok"; ids from `.data`.
                    if status.is_success() && resp_body.get("status").and_then(Value::as_str) == Some("ok") {
                        let data = resp_body.get("data").cloned().unwrap_or(Value::Null);
                        newly_restored.insert(tab_key_str.clone());
                        restored.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                            "tabId": data.get("tabId").cloned().unwrap_or(Value::Null),
                            "terminalId": data.get("terminalId").cloned().unwrap_or(Value::Null) }));
                    } else {
                        failed.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                            "status": status.as_u16(), "error": resp_body }));
                    }
                }
            }
        }
    }

    if !dry_run {
        if let Some(dd) = &device_dir {
            write_marker(dd, generation, &newly_restored,
                snap.get("capturedAt").and_then(Value::as_i64).unwrap_or(0));
        }
    }

    Json(json!({
        "deviceId": device_id,
        "generation": generation,
        "sourceCapturedAt": snap.get("capturedAt").cloned().unwrap_or(Value::Null),
        "broadcastScope": "all-connected-clients",
        "connectedClients": connected,
        "restored": restored,
        "skipped": skipped,
        "failed": failed,
    })).into_response()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run TWO commands (a single `-p A -p B <filter>` would apply the `tabs_snapshots`
name filter to BOTH crates and run NONE of `freshell-freshagent`'s tests — a
vacuous gate):
```
cargo test -p freshell-server tabs_snapshots   # the new REST tests
cargo test -p freshell-freshagent              # full suite -> proves the pub-visibility change regressed nothing
```
Expected: both PASS.

- [ ] **Step 5: Run fmt/clippy on touched crates**

Run: `cargo clippy -p freshell-server -p freshell-freshagent && cargo fmt --all -- --check && cargo build --release -p freshell-server`
Expected: clean.

- [ ] **Step 6: Add the DEVIATIONS ledger entry**

Append to `port/oracle/DEVIATIONS.md` under `## Ledger` (this is additive
beyond-legacy capability, not a behavior divergence of a ported surface —
say so explicitly so the oracle framing stays honest):

```markdown
### DEV-XXXX — ADDITIVE: tabs-sync snapshot generations + restore endpoints (no legacy counterpart)

- **id**: DEV-XXXX (next free number)
- **objective_defect**: n/a — additive capability, not a divergence in a ported
  behavior. Recorded here because the continuity trio
  (docs/plans/2026-07-22-continuity-safety-trio.md) introduces beyond-legacy
  surface: on-disk snapshot generations under `~/.freshell/tabs-snapshots/`
  (last 5 per device, empty-push guard) and REST
  `GET /api/tabs-sync/snapshots[/{deviceId}]` + `POST /api/tabs-sync/restore`.
- **original_behavior**: legacy tabs registry persists a hashed manifest/object
  store with TTLs but exposes no generation history, no snapshot read API, and
  no restore operation.
- **port_behavior**: in-memory registry unchanged on the wire; additive
  persistence + endpoints as above. `tabs.sync.*` WS semantics untouched.
- **fingerprint**: additive-only — new routes; no old-vs-new response diff on
  any ported route.
- **pinning_test**: crates/freshell-ws/src/tabs.rs (persistence tests),
  crates/freshell-server/src/tabs_snapshots.rs (REST tests),
  test/e2e-browser/specs/snapshot-restore-rust.spec.ts (round-trip).
- **adjudicated_by**: pending (flag for the next antagonist-review pass)
- **status**: proposed
```

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-server/src/tabs_snapshots.rs crates/freshell-freshagent/src/terminal_tabs.rs port/oracle/DEVIATIONS.md
git commit -m "feat(tabs-sync): POST /api/tabs-sync/restore rebuilds a device's tabs from a snapshot generation

Drives the existing POST /api/tabs create pipeline (the identity-stamping
path) per snapshot pane; unsupported kinds reported loudly, never silent.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 4: One-command operator restore script

**Files:**
- Create: `scripts/restore-tabs.sh` (mode 755)

**Interfaces:**
- Consumes: `GET /api/tabs-sync/snapshots`, `POST /api/tabs-sync/restore` (Tasks 2-3); auth header `x-auth-token`.
- Produces: `scripts/restore-tabs.sh --url <base> --token <tok> --device <deviceId> [--generation N] [--dry-run]` and `--list`. Exit 0 on success with 0 failed panes; exit 1 on any failed pane or HTTP error. Tasks 9-10's deploy script prints this exact invocation as remediation.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# restore-tabs.sh -- rebuild a device's tabs from its newest (or Nth) tabs-sync
# snapshot generation. Continuity trio deliverable 1
# (docs/plans/2026-07-22-continuity-safety-trio.md).
#
#   scripts/restore-tabs.sh --url http://127.0.0.1:PORT --token TOK --list
#   scripts/restore-tabs.sh --url http://127.0.0.1:PORT --token TOK \
#       --device <deviceId> [--generation N] [--dry-run]
#
# The target browser/device should be CONNECTED when you run this: restored
# tabs are delivered live via ui.command{tab.create}. Requires curl + jq.
# NOTE: --url is REQUIRED on purpose (no default) -- never point tooling at a
# server you did not intend.
set -euo pipefail

URL="" TOKEN="${FRESHELL_TOKEN:-}" DEVICE="" GENERATION=0 DRY_RUN=false LIST=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    --generation) GENERATION="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --list) LIST=true; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$URL" ]] || { echo "ERROR: --url is required" >&2; exit 2; }
[[ -n "$TOKEN" ]] || { echo "ERROR: --token (or FRESHELL_TOKEN) is required" >&2; exit 2; }

auth=(-H "x-auth-token: ${TOKEN}")

if $LIST; then
  curl -fsS "${auth[@]}" "${URL}/api/tabs-sync/snapshots" | jq -r '
    .devices[] | .deviceId as $d | .generations[] |
    "\($d)\tgen=\(.generation)\trev=\(.snapshotRevision)\trecords=\(.recordCount)\tcapturedAt=\(.capturedAt)\tlabel=\(.deviceLabel)"'
  exit 0
fi

[[ -n "$DEVICE" ]] || { echo "ERROR: --device is required (try --list)" >&2; exit 2; }

body=$(jq -n --arg d "$DEVICE" --argjson g "$GENERATION" --argjson dry "$DRY_RUN" \
  '{deviceId: $d, generation: $g, dryRun: $dry}')
resp=$(curl -fsS "${auth[@]}" -H 'content-type: application/json' \
  -d "$body" "${URL}/api/tabs-sync/restore") || {
  echo "ERROR: restore request failed (is the snapshot/device id right? try --list)" >&2
  exit 1
}

echo "== restore ${DEVICE} (generation ${GENERATION}) =="
echo "$resp" | jq -r '
  (.restored[] | "RESTORED  \(.kind)\t\(.tabKey)  tabId=\(.tabId)  terminalId=\(.terminalId // "-")"),
  (.skipped[]  | "SKIPPED   \(.kind)\t\(.tabKey)  reason=\(.reason)"),
  (.failed[]   | "FAILED    \(.kind)\t\(.tabKey)  status=\(.status)  \(.error | tostring)")'
restored=$(echo "$resp" | jq '.restored | length')
skipped=$(echo "$resp" | jq '.skipped | length')
failedn=$(echo "$resp" | jq '.failed | length')
echo "-- restored=${restored} skipped=${skipped} failed=${failedn}"
[[ "$failedn" == "0" ]] || exit 1
```

- [ ] **Step 2: Verify the script standalone (no browser)**

Manual smoke against an ephemeral server (NEVER :3001/:3002):

```bash
THOME=$(mktemp -d) && mkdir -p "$THOME/.freshell/tabs-snapshots/dev-1"
cat > "$THOME/.freshell/tabs-snapshots/dev-1/00000000000000002000-r3.json" <<'EOF'
{ "deviceId": "dev-1", "deviceLabel": "Dev", "clientInstanceId": "c1",
  "serverInstanceId": "s", "snapshotRevision": 3, "capturedAt": 2000,
  "records": [{ "tabKey": "dev-1:t1", "tabId": "t1", "tabName": "sh", "status": "open",
    "revision": 1, "updatedAt": 2000, "paneCount": 1,
    "panes": [{ "paneId": "p1", "kind": "terminal", "payload": { "mode": "shell" } }] }] }
EOF
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
FRESHELL_HOME=$THOME AUTH_TOKEN=devtok PORT=$PORT ./target/release/freshell-server &   # check main.rs:16-40 for the exact env names (token/port) the binary reads; adjust if they differ
SRV=$!
sleep 2
scripts/restore-tabs.sh --url "http://127.0.0.1:$PORT" --token devtok --list
scripts/restore-tabs.sh --url "http://127.0.0.1:$PORT" --token devtok --device dev-1 --dry-run
scripts/restore-tabs.sh --url "http://127.0.0.1:$PORT" --token devtok --device dev-1
kill $SRV; rm -rf "$THOME"
```

Expected: `--list` prints one `dev-1 gen=0` line; `--dry-run` prints one RESTORED line with `tabId=null`; real run prints `RESTORED terminal ... terminalId=term-...` and exits 0. (Confirm the binary's env names for port/token in `crates/freshell-server/src/main.rs` before running; the RustServer harness `boot()` shows the exact ones it passes.)

- [ ] **Step 3: Commit**

```bash
chmod +x scripts/restore-tabs.sh
git add scripts/restore-tabs.sh
git commit -m "feat(scripts): one-command tab restore operator script (restore-tabs.sh)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 5: Deliverable 1 acceptance — e2e snapshot→wipe→restore round-trip

**Files:**
- Create: `test/e2e-browser/specs/snapshot-restore-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (append to `rust-chromium`'s `testMatch` AND add a `testIgnore` entry to every match-all project — `chromium` + CI `firefox`/`webkit`)

**Interfaces:**
- Consumes: `createE2eServerHandle` (`../helpers/external-target.js`) + `TestHarness` (`../helpers/test-harness.js`); `POST /api/tabs` (envelope `.data`), `GET /api/tabs-sync/snapshots[/{device}]`, `GET /api/terminals` (RAW array), `scripts/restore-tabs.sh`; the fake-codex argv-recorder wiring — copy it EXACTLY from `codex-terminal-bounce-rust.spec.ts` (fake CLI is correct here: deliverable 1 proves identity plumbing, deliverable 2 proves real CLIs).
- Produces: the committed acceptance test for deliverable 1.

- [ ] **Step 1: Write the spec (failing only until Tasks 1-4 are in)**

Skeleton (fill the fake-codex install + `setupHome` config/session seeding by
copying the exact blocks from `codex-terminal-bounce-rust.spec.ts:49-165` — do
not invent your own):

```ts
import { test, expect } from '../helpers/fixtures.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'

const run = promisify(execFile)
const CODEX_SESSION_ID = '11111111-2222-4333-8444-555555555555'

// Boot a page against an already-started server (mirror of the inline sequence
// in codex-terminal-bounce-rust.spec.ts:169-174; there is NO bootAndConnect helper).
async function connect(page: import('@playwright/test').Page, info: any): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

// Find the codex tab's Redux pane content (uniform same-session evidence for
// codex, which /api/terminals deliberately omits sessionRef for).
async function codexPane(harness: TestHarness): Promise<any | null> {
  const state = await harness.getState()
  const tab = state.tabs.tabs.find((t: any) => t.mode === 'codex')
  return tab ? (await harness.getPaneLayout(tab.id))?.content ?? null : null
}

test.describe('tabs-sync snapshot -> wipe -> one-command restore (rust only)', () => {
  test('restored tabs point at the SAME sessions', async ({ browser, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust') // rust-only guard (this spec is also in every match-all project's testIgnore)
    test.setTimeout(240_000)
    const server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {
        env: { /* CODEX_CMD + FAKE_CODEX_ARGV_LOG, copied from the sibling */ },
        setupHome: async (homeDir) => { /* config.json + codex session seeding, copied from the sibling */ },
      },
    })
    const info = await server.start()
    try {
      // -- populate: one page = one deviceId/clientInstanceId --
      const ctx1 = await browser.newContext()
      const page1 = await ctx1.newPage()
      const harness1 = await connect(page1, info)
      const baseline = await harness1.getTabCount()

      const auth = { 'x-auth-token': info.token, 'content-type': 'application/json' }
      const mk = async (body: unknown) => {
        const r = await fetch(`${info.baseUrl}/api/tabs`, { method: 'POST', headers: auth, body: JSON.stringify(body) })
        expect(r.ok).toBe(true)
        return (await r.json()).data   // <-- unwrap the {status,data,message} envelope
      }
      await mk({ mode: 'shell', name: 'plain shell' })
      await mk({ browser: 'https://example.com', name: 'docs' })
      const codex = await mk({ mode: 'codex', name: 'codex work',
        sessionRef: { provider: 'codex', sessionId: CODEX_SESSION_ID } })
      expect(codex.terminalId).toBeTruthy()
      const codexTerminalIdBefore = codex.terminalId

      // -- wait for the client's tabs.sync push to persist a generation with all
      //    three tabs (incl. the codex sessionRef) --
      let deviceId = ''
      await expect(async () => {
        const data = await (await fetch(`${info.baseUrl}/api/tabs-sync/snapshots`, { headers: auth })).json()
        const dev = data.devices.find((d: any) => d.recordCount >= baseline + 3)
        expect(dev).toBeTruthy()
        deviceId = dev.deviceId
        const snap = await (await fetch(`${info.baseUrl}/api/tabs-sync/snapshots/${encodeURIComponent(deviceId)}`, { headers: auth })).json()
        const codexPaneSnap = snap.records.flatMap((rec: any) => rec.panes)
          .find((p: any) => p.payload?.sessionRef?.provider === 'codex')
        expect(codexPaneSnap?.payload?.sessionRef?.sessionId).toBe(CODEX_SESSION_ID)
      }).toPass({ timeout: 30_000 })

      // -- BYSTANDER: a SECOND connected browser context stays open. Restore drives
      //    the create pipeline, which broadcasts tab.create to ALL clients; with the
      //    original (wiped) client still connected there would be 2 clients, so
      //    restore's connected-client gate would 409. We therefore (a) prove the gate
      //    with 2 clients, then (b) close the bystander and restore into the single
      //    wiped client. --
      const bystanderCtx = await browser.newContext()
      const bystander = await connect(await bystanderCtx.newPage(), info)
      const bystanderBaseline = await bystander.getTabCount()

      // -- wipe: close the populated context (that client's state is gone) --
      await ctx1.close()

      // -- fresh browser context = the wiped client (reconnects, empty tab set) --
      const ctx2 = await browser.newContext()
      const page2 = await ctx2.newPage()
      const harness2 = await connect(page2, info)
      const freshCount = await harness2.getTabCount()

      // (a) GATE: with the wiped client + the bystander connected (>1), restore is refused.
      const gated = await run('scripts/restore-tabs.sh',
        ['--url', info.baseUrl, '--token', info.token, '--device', deviceId],
        { cwd: process.cwd() }).catch((e: any) => e)
      expect(String(gated.stderr ?? gated.stdout ?? '')).toMatch(/refused|409/i)

      // Close the bystander so exactly ONE client remains, then restore for real.
      // Retry until the server's connected-client count settles to 1 (a 409
      // creates nothing + writes no marker, so retrying is safe/idempotent).
      await bystanderCtx.close()
      await expect(async () => {
        const { stdout } = await run('scripts/restore-tabs.sh',
          ['--url', info.baseUrl, '--token', info.token, '--device', deviceId],
          { cwd: process.cwd() })
        expect(stdout).toContain('failed=0')
      }).toPass({ timeout: 20_000 })

      // -- the wiped client received the restored tabs live --
      await expect(async () => {
        expect(await harness2.getTabCount()).toBe(freshCount + 3)
      }).toPass({ timeout: 20_000 })

      // -- SAME session: the restored codex pane carries the identical sessionRef
      //    (Redux, from the ui.command tab.create payload) on a NEW terminal --
      await expect(async () => {
        const content = await codexPane(harness2)
        expect(content?.sessionRef?.sessionId).toBe(CODEX_SESSION_ID)
        expect(content?.terminalId).toBeTruthy()
        expect(content?.terminalId).not.toBe(codexTerminalIdBefore)
      }).toPass({ timeout: 20_000 })

      // -- a live codex terminal exists (server-side; RAW array, codex has no sessionRef here) --
      const terms = await (await fetch(`${info.baseUrl}/api/terminals`, { headers: auth })).json()
      expect(terms.some((t: any) => t.mode === 'codex')).toBe(true)

      // -- IDEMPOTENCY: a second restore of the same generation is a no-op (all skips) --
      const { stdout: rerun } = await run('scripts/restore-tabs.sh',
        ['--url', info.baseUrl, '--token', info.token, '--device', deviceId],
        { cwd: process.cwd() })
      expect(rerun).toMatch(/restored=0/)
      expect(rerun).toContain('failed=0')
      await expect(async () => {
        expect(await harness2.getTabCount()).toBe(freshCount + 3) // unchanged
      }).toPass({ timeout: 10_000 })

      await ctx2.close()
    } finally {
      await server.stop()
    }
  })
})
```

Mirror the sibling's imports and fake-CLI/`setupHome` blocks verbatim. Note:
`GET /api/terminals` (RAW array) DELIBERATELY omits `sessionRef` for codex
(`terminals.rs:674-682`), so codex same-session identity is asserted via the
Redux pane (`harness.getPaneLayout(tabId).content.sessionRef`), NOT via
`/api/terminals`. The restore-tabs.sh output line `restored=N skipped=M
failed=K` is what the assertions above key on.

- [ ] **Step 2: Register the spec (`rust-chromium` testMatch + match-all testIgnore)**

In `playwright.config.ts`, append to the `rust-chromium` `testMatch` array:

```ts
        // CONTINUITY TRIO deliverable 1 (docs/plans/2026-07-22-continuity-safety-trio.md):
        // snapshot generations + one-command restore round-trip. Rust-only:
        // legacy has no persisted snapshot generations or restore endpoint.
        /snapshot-restore-rust\.spec\.ts$/,
```

AND introduce the shared `RUST_ONLY_SPECS` testIgnore list (Deliverable 1 lands
FIRST, so it is defined HERE; Task 7 and Task 10 append their specs to it). A
rust-only spec's in-body `expect(e2eServerKind).toBe('rust')` does NOT exclude
it from a match-all project — it FAILS there — so every match-all project
(`chromium`, and CI `firefox`/`webkit`) MUST `testIgnore` it. Above the
`projects` array:

```ts
// CONTINUITY TRIO: rust-only specs kept out of every match-all project
// (their e2eServerKind:'rust' guard FAILS under the fixture-default 'legacy').
// Task 7 appends /continuity-smoke\.spec\.ts$/ and Task 10 appends
// /deploy-tab-diff-rust\.spec\.ts$/.
const RUST_ONLY_SPECS = [
  /snapshot-restore-rust\.spec\.ts$/,
]
```

and add `testIgnore: RUST_ONLY_SPECS` to `chromium` (and, inside the
`process.env.CI ? [...] : []` array, to `firefox`/`webkit`):

```ts
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: RUST_ONLY_SPECS },
```
Verify: `npx playwright test --config test/e2e-browser/playwright.config.ts --list | grep snapshot-restore-rust` shows it ONLY under `[rust-chromium]`.

- [ ] **Step 3: Run it twice**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium snapshot-restore-rust.spec.ts --repeat-each=2`
Expected: 2 passed. (Build the release server first if needed: `cargo build --release -p freshell-server` — the harness also builds on demand.)

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/snapshot-restore-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): snapshot->wipe->restore round-trip proves tabs come back with the same sessions

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## DELIVERABLE 2 — The 3-minute continuity smoke test (real CLIs)

### Task 6: Harness binary override + real-CLI offline-resume probes

**Files:**
- Modify: `test/e2e-browser/helpers/rust-server.ts`
- Probe artifacts: findings recorded as the header comment of Task 7's spec + in `docs/plans/2026-07-22-continuity-smoke-evidence.md` (created in Task 8)

**Interfaces:**
- Consumes: `RustServer.boot()` (`rust-server.ts:296-300`, calls `ensureRustServerBuilt()`).
- Produces: env override `FRESHELL_E2E_RUST_SERVER_BIN` — when set to an existing file, `boot()` uses it instead of building HEAD. Needed by Task 8's historical-bug proof.

- [ ] **Step 1: Add the override (test infra, not frozen)**

In `rust-server.ts` `boot()`, replace `const bin = ensureRustServerBuilt()` with:

```ts
    // CONTINUITY TRIO (docs/plans/2026-07-22-continuity-safety-trio.md):
    // point the harness at an alternative freshell-server binary (e.g. one
    // built from a historical commit) to prove a spec CATCHES a regression.
    const overrideBin = process.env.FRESHELL_E2E_RUST_SERVER_BIN
    const bin = overrideBin && fs.existsSync(overrideBin) ? overrideBin : ensureRustServerBuilt()
```

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium harness-01-rust-server.spec.ts`
Expected: PASS (harness self-test unaffected when the env var is unset).

- [ ] **Step 2: Probe — does each REAL CLI render seeded history offline?**

The smoke test's strongest assertion is "seeded MARKER text visible in the
resumed pane" with NO API keys. Verify each CLI supports that before writing
the spec. All probes in a throwaway HOME; `script -qec` provides a PTY. Use
UUIDv4 session ids.

```bash
PROBE=$(mktemp -d); CWD="$PROBE/proj"; mkdir -p "$CWD"
CID=$(python3 -c 'import uuid; print(uuid.uuid4())')   # codex
ALID=amp-continuity-probe                              # amplifier
CLID=$(python3 -c 'import uuid; print(uuid.uuid4())')  # claude

# codex rollout (real layout: sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl)
D="$PROBE/.codex/sessions/2026/07/22"; mkdir -p "$D"
cat > "$D/rollout-2026-07-22T08-00-00-$CID.jsonl" <<EOF
{"timestamp":"2026-07-22T08:00:00.000Z","type":"session_meta","payload":{"id":"$CID","cwd":"$CWD"}}
{"timestamp":"2026-07-22T08:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"MARKER-CODEX-7f3a the aubergine protocol"}]}}
{"timestamp":"2026-07-22T08:00:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ack MARKER-CODEX-7f3a"}]}}
EOF
(cd "$CWD" && HOME="$PROBE" timeout 30 script -qec "codex resume $CID" /dev/null > /tmp/probe-codex.out || true)
grep -c "MARKER-CODEX-7f3a" /tmp/probe-codex.out

# amplifier session dir
AD="$PROBE/.amplifier/projects/probe-proj/sessions/$ALID"; mkdir -p "$AD"
cat > "$AD/metadata.json" <<EOF
{"session_id":"$ALID","working_dir":"$CWD","created":"2026-07-22T08:00:00.000Z","name":"probe","description":"probe"}
EOF
printf '%s\n%s\n' \
  '{"role":"user","content":"MARKER-AMP-9c1e the cerulean ledger"}' \
  '{"role":"assistant","content":"ack MARKER-AMP-9c1e"}' > "$AD/transcript.jsonl"
(cd "$CWD" && HOME="$PROBE" timeout 30 script -qec "amplifier resume $ALID" /dev/null > /tmp/probe-amp.out || true)
grep -c "MARKER-AMP-9c1e" /tmp/probe-amp.out
# If `amplifier resume` is not the real verb, check what the server launches:
# grep -rn "amplifier" crates/freshell-platform/src/cli_launch_goldens.rs (resume args template)
# and try `amplifier --help`.

# claude project session (cwd-munged dir; format may need iteration -- if the
# first shape fails, copy a REAL session file's first 3 lines from your own
# ~/.claude/projects/** as the template, replacing text with MARKERs)
MUNGED=$(python3 -c "import sys; print(sys.argv[1].replace('/', '-'))" "$CWD")
CD="$PROBE/.claude/projects/$MUNGED"; mkdir -p "$CD"
cat > "$CD/$CLID.jsonl" <<EOF
{"type":"user","uuid":"$(python3 -c 'import uuid; print(uuid.uuid4())')","sessionId":"$CLID","timestamp":"2026-07-22T08:00:01.000Z","cwd":"$CWD","message":{"role":"user","content":[{"type":"text","text":"MARKER-CLAUDE-4b8d the vermilion archive"}]}}
{"type":"assistant","uuid":"$(python3 -c 'import uuid; print(uuid.uuid4())')","sessionId":"$CLID","timestamp":"2026-07-22T08:00:02.000Z","cwd":"$CWD","message":{"role":"assistant","content":[{"type":"text","text":"ack MARKER-CLAUDE-4b8d"}]}}
EOF
(cd "$CWD" && HOME="$PROBE" timeout 30 script -qec "claude --resume $CLID" /dev/null > /tmp/probe-claude.out || true)
grep -c "MARKER-CLAUDE-4b8d" /tmp/probe-claude.out
rm -rf "$PROBE"
```

For each CLI record: (a) does resume render the MARKER offline (grep count ≥ 1)?
(b) if not, does it at least accept the session id? Iterate the fixture shape
until the CLI renders it, or conclude it genuinely cannot render offline.
**Fallback rule (spec-mandated), corrected for what the Rust server actually
exposes:** any leg whose CLI cannot render history offline downgrades to a
SAME-SESSION identity assertion — (i) the resumed pane's Redux
`content.sessionRef.sessionId` is unchanged, read via
`harness.getPaneLayout(tabId).content.sessionRef` (the uniform, provider-agnostic
evidence carried in the `ui.command tab.create` payload — this is exactly how
`codex-terminal-bounce-rust.spec.ts` proves identity). Do NOT depend on
`GET /api/terminals` `sessionRef` (it is OMITTED for codex/shell) nor on
`info.debugLogPath`/the `terminal.created` log line (the debug path is the wrong
filename for the Rust server, and that log record carries only `resume_applied:
bool`, not the id — verified `registry.rs:588-595`, `logging.rs:74`,
`rust-server.ts:376`). If a raw-argv proof is additionally wanted for a
FAKE-CLI leg, use that CLI's argv recorder (e.g. `FAKE_CODEX_ARGV_LOG`); real
CLIs have no argv log, so their downgrade proof is the Redux `sessionRef`.
Document the downgrade + probe evidence in the spec header comment AND the
evidence file. Also record whether each CLI needs auth state
copied into the throwaway HOME to even start (e.g. `~/.codex/auth.json`,
`~/.claude/.credentials.json`) — resume-render needs no API calls, but the
binary may refuse to start unauthenticated; if so, the spec's `setupHome`
copies ONLY the auth file from the real HOME (read-only copy, never written
back).

- [ ] **Step 3: Commit the harness knob**

```bash
git add test/e2e-browser/helpers/rust-server.ts
git commit -m "test(e2e): FRESHELL_E2E_RUST_SERVER_BIN override for historical-regression proof runs

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 7: The continuity smoke spec (real server, real CLIs), outside the default matrix

**Files:**
- Create: `test/e2e-browser/specs/continuity-smoke.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (new `continuity-smoke` project; `testIgnore` on every project that has no explicit `testMatch`)
- Modify: `package.json` (`smoke:continuity` script)

**Interfaces:**
- Consumes: `createE2eServerHandle` (`kind:'rust'`, `construct.setupHome`, `server.restart()`) + `TestHarness` (`waitForHarness`/`waitForConnection`/`getWsReadyState`/`getPaneLayout`), sidebar interactions (mirror `sidebar-click-resume.spec.ts:215-235`), `POST /api/tabs` with `sessionRef` (envelope `.data`), `GET /api/terminals` (RAW array), `GET /api/terminals/{id}/search?q=<marker>` → `.matches` (server-side scrollback mirror — the strongest render assertion), Task 6 probe findings.
- Produces: `npm run smoke:continuity` — the pre-deploy gate. NOT run by `chromium`/`rust-chromium`/`legacy-chromium`.

- [ ] **Step 1: Register the project + npm script FIRST (so the spec never leaks into the default matrix)**

`playwright.config.ts` — APPEND the smoke spec to the shared `RUST_ONLY_SPECS`
list Task 5 already introduced (it is already applied as `testIgnore` on every
match-all project — `chromium` and CI `firefox`/`webkit`; do NOT redefine those
projects, just extend the array):

```ts
const RUST_ONLY_SPECS = [
  /snapshot-restore-rust\.spec\.ts$/,     // Task 5 (already present)
  /continuity-smoke\.spec\.ts$/,          // <-- add now
  // Task 10 appends /deploy-tab-diff-rust\.spec\.ts$/
]
```

Register the smoke project (dedicated, outside the default matrix):

```ts
    // CONTINUITY SMOKE (pre-deploy gate): REAL freshell-server binary + REAL
    // codex/amplifier/claude CLIs from PATH. Run via `npm run smoke:continuity`.
    {
      name: 'continuity-smoke',
      use: { ...devices['Desktop Chrome'], e2eServerKind: 'rust' as const },
      testMatch: [/continuity-smoke\.spec\.ts$/],
    },
```

Verify exclusion (with and without CI): the smoke spec must appear ONLY under
`[continuity-smoke]`, and `snapshot-restore-rust`/`deploy-tab-diff-rust` must
NOT appear under `[chromium]`:
```
npx playwright test --config test/e2e-browser/playwright.config.ts --list | grep -E 'continuity-smoke|snapshot-restore-rust|deploy-tab-diff-rust'
CI=1 npx playwright test --config test/e2e-browser/playwright.config.ts --list | grep -E 'continuity-smoke|snapshot-restore-rust|deploy-tab-diff-rust'
```
Neither listing may show any of the three under `[chromium]`, `[firefox]`, or `[webkit]`.

`package.json` scripts:

```json
"smoke:continuity": "playwright test --config test/e2e-browser/playwright.config.ts --project=continuity-smoke"
```

- [ ] **Step 2: Write the smoke spec**

One scenario, one server, one page. Constants: three MARKERs + three session
ids as in the Task 6 probe. Structure (fill fixture-seeding bodies from the
probe's final working shapes; header comment records probe results and any
per-CLI fallback downgrade):

```ts
import { test, expect } from '../helpers/fixtures.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'

const MARKERS = {
  codex: 'MARKER-CODEX-7f3a the aubergine protocol',
  amplifier: 'MARKER-AMP-9c1e the cerulean ledger',
  claude: 'MARKER-CLAUDE-4b8d the vermilion archive',
}
const IDS = {
  codex: '<uuid used in probe>',
  amplifier: 'amp-continuity-smoke',
  claude: '<uuid used in probe>',
}

// mirror of codex-terminal-bounce-rust.spec.ts:169-174 (no bootAndConnect helper exists)
async function connect(page: import('@playwright/test').Page, info: any): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

test.describe('continuity smoke (REAL CLIs) -- pre-deploy gate', () => {
  test('three real panes survive server restart + page reload with the same sessions', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(300_000) // whole scenario ~3-4 min
    const server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {
        // NO fake-CLI env: real codex/amplifier/claude from PATH on purpose.
        setupHome: async (homeDir) => {
          const cwd = path.join(homeDir, 'proj'); await fs.mkdir(cwd, { recursive: true })
          // seed codex rollout under .codex/sessions/2026/07/22/rollout-...-<id>.jsonl  (probe shape)
          // seed amplifier .amplifier/projects/smoke/sessions/<id>/{metadata.json,transcript.jsonl}
          // seed claude .claude/projects/<munged-cwd>/<id>.jsonl                        (probe shape)
          // copy auth files ONLY if the Task 6 probe proved they are required to start
        },
      },
    })
    const info = await server.start()
    try {
      let harness = await connect(page, info)
      const auth = { 'x-auth-token': info.token, 'content-type': 'application/json' }
      const cwd = path.join(info.homeDir, 'proj')
      const baseline = await harness.getTabCount()

      // -- LEG 1 (user path: sidebar click) -- codex --
      // (the sidebar lists the seeded session by extracted title; mirror
      //  sidebar-click-resume.spec.ts's locator strategy exactly)
      await page.getByText('MARKER-CODEX', { exact: false }).first().click()

      // -- LEGS 2+3 (agent/API path: REST create with sessionRef) --
      for (const p of ['amplifier', 'claude'] as const) {
        const r = await fetch(`${info.baseUrl}/api/tabs`, { method: 'POST', headers: auth,
          body: JSON.stringify({ mode: p, cwd, name: `smoke ${p}`,
            sessionRef: { provider: p, sessionId: IDS[p] } }) })
        expect(r.ok).toBe(true)
      }

      // Find a live terminal by mode from the RAW /api/terminals array.
      const termByMode = async (mode: string) =>
        (await (await fetch(`${info.baseUrl}/api/terminals`, { headers: auth })).json())
          .find((t: any) => t.mode === mode)
      // Same-session identity, uniform across providers, from the Redux pane.
      const paneByMode = async (h: TestHarness, mode: string) => {
        const st = await h.getState()
        const tab = st.tabs.tabs.find((t: any) => t.mode === mode)
        return tab ? (await h.getPaneLayout(tab.id))?.content ?? null : null
      }

      const expectContinuity = async (h: TestHarness, phase: string) => {
        await expect(async () => {
          expect(await h.getTabCount()).toBe(baseline + 3)
        }).toPass({ timeout: 30_000 })
        await expect(async () => {
          for (const p of ['codex', 'amplifier', 'claude'] as const) {
            // (2) same session id (Redux pane -- works for codex; /api/terminals omits it)
            const content = await paneByMode(h, p)
            expect(content?.sessionRef?.sessionId, `${phase}: ${p} same session`).toBe(IDS[p])
            // (3) MARKER visible in the pane's server-side scrollback mirror, IF the
            //     Task 6 probe proved this CLI renders offline; otherwise the leg is
            //     downgraded to identity-only (documented in the header comment).
            const t = await termByMode(p)
            expect(t, `${phase}: ${p} terminal live`).toBeTruthy()
            const s = await (await fetch(
              `${info.baseUrl}/api/terminals/${t.terminalId}/search?q=${encodeURIComponent(MARKERS[p].slice(0, 20))}`,
              { headers: auth })).json()
            // s.matches is the search response array (terminals.rs:392).
            expect(s.matches.length, `${phase}: ${p} MARKER rendered by real CLI`).toBeGreaterThan(0)
          }
        }).toPass({ timeout: 60_000 })
      }

      await expectContinuity(harness, 'initial open')

      // -- DISRUPTION 1: server restart WITHOUT page reload -- wait for WS reconnect
      //    exactly like codex-terminal-bounce-rust.spec.ts:229-239 (getWsReadyState). --
      await server.restart()
      await expect(async () => {
        const ready = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(ready).toBe('ready')
      }).toPass({ timeout: 60_000 })
      await expectContinuity(harness, 'after restart (no reload)')

      // -- DISRUPTION 2: page reload --
      await page.reload()
      harness = await connect(page, info)
      await expectContinuity(harness, 'after reload')
    } finally {
      await server.stop()
    }
  })
})
```

Implementation notes (bake into the spec, adjusting to reality found while
writing):
- Baseline tab count: read `harness.getTabCount()` right after the first
  `connect(page, info)` and assert `baseline + 3` thereafter — do not hardcode.
- Tab-count "same tab count" assertion applies after each disruption, per spec.
- The reconnect-wait: copy `codex-terminal-bounce-rust.spec.ts:229-239` verbatim
  (poll `getWsReadyState()` for `'ready'`); do NOT invent `harnessReady` and do
  NOT read `.connection` off `harness.getState()` synchronously (it is a Promise).
- Sidebar leg: the seeded codex session's TITLE comes from the first user
  message — so the MARKER sentence doubles as the sidebar label; mirror
  `sidebar-click-resume.spec.ts`'s `sidebar-session-list` +
  `getByText(...).click()` flow.
- codex sessionRef for the sidebar leg is stamped by the client's gold path
  (`openSessionTab`), then re-derived server-side on restart — this is exactly
  the `136b9e94` surface the proof run exercises.
- If the Task 6 probe downgraded a leg (CLI cannot render offline): drop that
  leg's `search`/`.matches` assertion and keep ONLY the identity assertion —
  the resumed pane's Redux `content.sessionRef.sessionId` unchanged (via
  `paneByMode`) — and say so in the header comment + evidence file. Do NOT use
  `info.debugLogPath` (wrong filename) or the `terminal.created` log (no resume
  id, only `resume_applied: bool`).
- Keep total runtime ≤ 4 min: single worker, no `--repeat-each`, tight polls.

- [ ] **Step 3: Run to verify it fails/errors before fixture tuning, then passes**

Run: `npm run smoke:continuity`
Iterate fixture shapes (per Task 6 probes) until: PASS with all three legs on
their strongest supported assertion. Then run once more: PASS 2x consecutive.
Record wall-clock (target ≤ 4 min).

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/continuity-smoke.spec.ts test/e2e-browser/playwright.config.ts package.json
git commit -m "test(smoke): 3-minute real-CLI continuity smoke as a pre-deploy gate (npm run smoke:continuity)

Real freshell-server + real codex/amplifier/claude resume legs; seeded
MARKER transcripts asserted through the server scrollback mirror after a
no-reload server restart and again after a page reload. Outside the
default matrix by design.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 8: Prove the smoke test catches the historical codex-identity bug

**Files:**
- Create: `docs/plans/2026-07-22-continuity-smoke-evidence.md`

**Interfaces:**
- Consumes: `FRESHELL_E2E_RUST_SERVER_BIN` (Task 6), `npm run smoke:continuity` (Task 7), commit `136b9e94~1` (contains the real bug: codex terminal creates ignored `sessionRef`).
- Produces: committed evidence — codex leg FAILS at `136b9e94~1`, full run PASSES at HEAD.

- [ ] **Step 1: Build the pre-fix server binary in an ephemeral worktree**

```bash
cd <worktree-root>
git worktree add /tmp/freshell-pre-136b9e94 136b9e94~1
(cd /tmp/freshell-pre-136b9e94 && cargo build --release -p freshell-server)
```

(Build is read-only w.r.t. this repo's frozen paths; the temp worktree is
removed in Step 4.)

- [ ] **Step 2: Run the smoke against the OLD binary — expect the codex leg to FAIL**

```bash
# `set -o pipefail` + PIPESTATUS[0] so `tee` cannot mask the real npm exit code
# (without it, `$?` after `... | tee` is tee's status, normally 0).
set -o pipefail
FRESHELL_E2E_RUST_SERVER_BIN=/tmp/freshell-pre-136b9e94/target/release/freshell-server \
  npm run smoke:continuity 2>&1 | tee /tmp/smoke-pre-fix.out
echo "exit=${PIPESTATUS[0]}"   # MUST be non-zero
```

Expected: non-zero exit; the failing assertion is the codex leg (either the
initial `MARKER rendered by real CLI` for codex — the pre-fix WS create
ignores `sessionRef`, spawns plain `codex`, so the seeded history never
renders — or the post-restart codex `same session`/MARKER assertion).
Amplifier/claude legs are not the failing assertion. If the run instead fails
for an unrelated reason (e.g. the old binary predates an endpoint the spec
uses — note `GET /api/terminals/{id}/search` DOES exist pre-`136b9e94`, it
shipped with `terminals.rs`; verify with
`git show 136b9e94~1:crates/freshell-server/src/terminals.rs | grep -n search`),
adjust the spec to only use surfaces present in both binaries, re-run Task 7's
pass, then repeat this step.

- [ ] **Step 3: Run at HEAD — expect PASS — and write the evidence file**

```bash
set -o pipefail
npm run smoke:continuity 2>&1 | tee /tmp/smoke-head.out
echo "exit=${PIPESTATUS[0]}"   # MUST be 0
```

Create `docs/plans/2026-07-22-continuity-smoke-evidence.md`:

```markdown
# Continuity smoke — regression-catch evidence (2026-07-22)

Proof that `npm run smoke:continuity` catches the identity-loss category:
run against `136b9e94~1` (real historical bug: codex terminal creates
ignored sessionRef) the codex leg FAILS; at HEAD (`<head sha>`) it PASSES.

## Probe findings (Task 6)
- codex resume offline render: <result>; auth file needed: <yes/no>
- amplifier resume offline render: <result>; downgrade applied: <none|argv+id>
- claude --resume offline render: <result>; downgrade applied: <none|argv+id>

## FAIL @ 136b9e94~1 (binary override), exit=<n>
```text
<trimmed tail of /tmp/smoke-pre-fix.out — the failing codex assertion + summary>
```

## PASS @ HEAD, exit=0, wall clock <m>m<s>s
```text
<trimmed tail of /tmp/smoke-head.out — the 1 passed summary>
```
```

- [ ] **Step 4: Clean up + commit**

```bash
git worktree remove /tmp/freshell-pre-136b9e94 --force
git add docs/plans/2026-07-22-continuity-smoke-evidence.md
git commit -m "docs: continuity smoke regression-catch evidence (FAIL @136b9e94~1, PASS @HEAD)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## DELIVERABLE 3 — Deploy tab-diff ritual

### Task 9: `scripts/deploy-tab-diff.sh` (capture / verify, GETs only)

**Files:**
- Create: `scripts/deploy-tab-diff.sh` (mode 755)

**Interfaces:**
- Consumes: `GET /api/tabs-sync/snapshots`, `GET /api/tabs-sync/snapshots/{device}` (Task 2), `GET /api/terminals` (existing). STRICTLY read-only against the server.
- Produces:
  - `scripts/deploy-tab-diff.sh capture --url U --token T --out FILE` → writes `{"capturedAt", "url", "devices": {"<deviceId>": <newest UNION snapshot>}, "terminals": [<raw /api/terminals array>]}`.
  - `scripts/deploy-tab-diff.sh verify --url U --token T --before FILE` → exit 0 when every previously-live identity pane came back with the SAME `sessionRef`; exit 1 with a loud pane-by-pane diff (`MISSING` / `FRESH (identity lost)` / `RE-POINTED` / `NOT RESPAWNED`) and the exact `restore-tabs.sh --generation <last-good>` remediation otherwise.
  - Verify semantics (liveness gated on the BEFORE state, so no vacuous OK and no false red): a pane is "counted" only if it had a `payload.sessionRef` OR its `payload.liveTerminal.terminalId` was ACTUALLY present in the before `/api/terminals` array (a stale snapshot from an offline/reaped device is NOT asserted). For each counted pane, find the same `(tabKey, paneId)` in the device's AFTER union snapshot: absent → `MISSING`; before had `sessionRef` and after doesn't → `FRESH`; both present but `sessionId`/`provider` differ → `RE-POINTED`; a genuinely-live-before pane whose after `liveTerminal.terminalId` is absent from the after `/api/terminals` array → `NOT RESPAWNED`. Guard: if the before capture saw live terminals but ZERO persisted device snapshots, verify FAILS loudly (persistence gap), never a silent OK. Remediation prints, per diverged device, the `--generation` index of the newest generation whose `capturedAt <= before.capturedAt` (the last-good pre-divergence snapshot), NOT generation 0 (which after identity loss is the degraded newest).

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# deploy-tab-diff.sh -- pre/post-restart tab identity ritual (continuity trio
# deliverable 3, docs/plans/2026-07-22-continuity-safety-trio.md).
#
#   scripts/deploy-tab-diff.sh capture --url U --token T --out before.json
#   ... restart/deploy the server ...
#   scripts/deploy-tab-diff.sh verify  --url U --token T --before before.json
#
# READ-ONLY against the server (GETs only). Exit non-zero on any divergence.
# NEVER point this at a server you do not operate. Requires curl + jq.
set -euo pipefail

CMD="${1:-}"; shift || true
URL="" TOKEN="${FRESHELL_TOKEN:-}" OUT="" BEFORE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --before) BEFORE="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$URL" && -n "$TOKEN" ]] || { echo "ERROR: --url and --token are required" >&2; exit 2; }
auth=(-H "x-auth-token: ${TOKEN}")

fetch_state() {
  local devices terminals
  devices=$(curl -fsS "${auth[@]}" "${URL}/api/tabs-sync/snapshots" \
    | jq -r '.devices[].deviceId')
  local dev_json="{}"
  for d in $devices; do
    snap=$(curl -fsS "${auth[@]}" "${URL}/api/tabs-sync/snapshots/${d}")
    dev_json=$(jq --arg d "$d" --argjson s "$snap" '. + {($d): $s}' <<<"$dev_json")
  done
  # GET /api/terminals with NO read-model query params returns a RAW ARRAY
  # (terminals.rs:414); `.items` would be null. Keep the array as-is.
  terminals=$(curl -fsS "${auth[@]}" "${URL}/api/terminals")
  jq -n --arg url "$URL" --argjson devices "$dev_json" --argjson terminals "$terminals" \
    '{capturedAt: (now * 1000 | floor), url: $url, devices: $devices, terminals: $terminals}'
}

case "$CMD" in
  capture)
    [[ -n "$OUT" ]] || { echo "ERROR: capture requires --out FILE" >&2; exit 2; }
    fetch_state > "$OUT"
    echo "captured $(jq '.devices | length' "$OUT") device snapshot(s), $(jq '.terminals | length' "$OUT") live terminal(s) -> $OUT"
    ;;
  verify)
    [[ -n "$BEFORE" && -f "$BEFORE" ]] || { echo "ERROR: verify requires --before FILE" >&2; exit 2; }
    AFTER=$(mktemp); fetch_state > "$AFTER"

    # Vacuous-OK guard: if the BEFORE capture saw live terminals but persisted
    # ZERO device snapshots, tabs-sync persistence was broken at capture time --
    # there is nothing to verify against, so fail LOUDLY instead of a silent OK.
    before_terms=$(jq '.terminals | length' "$BEFORE")
    before_devs=$(jq '.devices | length' "$BEFORE")
    if [[ "$before_terms" -gt 0 && "$before_devs" -eq 0 ]]; then
      echo "FAIL: before-capture had ${before_terms} live terminal(s) but 0 persisted device snapshots -- tabs-sync persistence appears broken." >&2
      rm -f "$AFTER"; exit 1
    fi

    # Pane-by-pane identity diff. Liveness is gated on the BEFORE /api/terminals
    # set: a pane counts only if it carried session identity OR was ACTUALLY live
    # at capture (its liveTerminalId was in before.terminals). Stale snapshots
    # from offline/reaped devices therefore never produce a false NOT RESPAWNED.
    DIFF=$(jq -n --slurpfile b "$BEFORE" --slurpfile a "$AFTER" '
      def panes(dev; snap):
        (snap.records // [])[] | select(.status == "open") as $rec
        | ($rec.panes // [])[]
        | {device: dev, tabKey: $rec.tabKey, tabName: $rec.tabName, paneId: .paneId,
           kind: .kind, sessionRef: .payload.sessionRef,
           liveTerminalId: .payload.liveTerminal.terminalId};
      ($b[0].terminals | map(.terminalId)) as $liveBefore
      | ($a[0].terminals | map(.terminalId)) as $liveNow
      | ($b[0].devices | to_entries | map(panes(.key; .value)) | flatten) as $before
      | ($a[0].devices | to_entries | map(panes(.key; .value)) | flatten) as $after
      | [ $before[]
          | . as $bp
          | (($bp.sessionRef != null)
             or ($bp.liveTerminalId != null and (($liveBefore | index($bp.liveTerminalId)) != null))) as $counted
          | select($counted)
          | ($after | map(select(.tabKey == $bp.tabKey and .paneId == $bp.paneId)) | first) as $ap
          | if $ap == null then
              {verdict: "MISSING", pane: $bp}
            elif ($bp.sessionRef != null and $ap.sessionRef == null) then
              {verdict: "FRESH (identity lost)", pane: $bp}
            elif ($bp.sessionRef != null and $ap.sessionRef != null
                  and ($bp.sessionRef.provider != $ap.sessionRef.provider
                       or $bp.sessionRef.sessionId != $ap.sessionRef.sessionId)) then
              {verdict: "RE-POINTED", pane: $bp, after: $ap.sessionRef}
            elif ($bp.liveTerminalId != null and (($liveBefore | index($bp.liveTerminalId)) != null)
                  and (($ap.liveTerminalId == null) or (($liveNow | index($ap.liveTerminalId)) == null))) then
              {verdict: "NOT RESPAWNED", pane: $bp}
            else empty end ]')
    COUNT=$(jq 'length' <<<"$DIFF")
    if [[ "$COUNT" == "0" ]]; then
      echo "OK: every previously-live pane came back with the same session identity."
      rm -f "$AFTER"; exit 0
    fi
    echo "================ TAB-DIFF DIVERGENCE (${COUNT}) ================"
    jq -r '.[] | "\(.verdict)\tdevice=\(.pane.device)\ttab=\(.pane.tabName) (\(.pane.tabKey))\tpane=\(.pane.paneId)\tkind=\(.pane.kind)\twas=\(.pane.sessionRef.provider // "-"):\(.pane.sessionRef.sessionId // "-")\(if .after then "\tnow=\(.after.provider):\(.after.sessionId)" else "" end)"' <<<"$DIFF"
    echo "================================================================"
    # Remediation restores the LAST-GOOD generation, NOT the (now-newest,
    # degraded) generation 0: pick the newest generation whose capturedAt is at
    # or before the good BEFORE capture time.
    echo "REMEDIATION (rebuild each diverged device from its LAST-GOOD generation):"
    before_captured=$(jq '.capturedAt' "$BEFORE")
    snaps=$(curl -fsS "${auth[@]}" "${URL}/api/tabs-sync/snapshots")
    for dev in $(jq -r '[.[].pane.device] | unique | .[]' <<<"$DIFF"); do
      gen=$(jq -r --arg d "$dev" --argjson t "$before_captured" '
        (.devices[] | select(.deviceId == $d) | .generations
         | map(select(.capturedAt <= $t)) | (.[0].generation // 0))' <<<"$snaps")
      echo "  scripts/restore-tabs.sh --url ${URL} --token <TOKEN> --device ${dev} --generation ${gen}"
    done
    rm -f "$AFTER"; exit 1
    ;;
  *)
    echo "usage: deploy-tab-diff.sh {capture|verify} --url U --token T [--out F|--before F]" >&2
    exit 2 ;;
esac
```

- [ ] **Step 2: Syntax check**

Run: `bash -n scripts/deploy-tab-diff.sh && shellcheck scripts/deploy-tab-diff.sh || true`
Expected: `bash -n` clean (fix any shellcheck findings that are real bugs; style-only findings may stand).

- [ ] **Step 3: Commit**

```bash
chmod +x scripts/deploy-tab-diff.sh
git add scripts/deploy-tab-diff.sh
git commit -m "feat(scripts): deploy tab-diff ritual -- capture/verify pane identity across a restart (read-only)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 10: Deliverable 3 acceptance — capture → restart → verify passes; identity loss fails loudly

**Files:**
- Create: `test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (append to `rust-chromium` `testMatch` with a doc comment)

**Interfaces:**
- Consumes: everything above; fake-codex wiring copied from `codex-terminal-bounce-rust.spec.ts` (ephemeral server, per Global Constraints).
- Produces: committed acceptance for deliverable 3.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '../helpers/fixtures.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'

const run = promisify(execFile)
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

async function connect(page: import('@playwright/test').Page, info: any): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

async function tabDiff(args: string[]) {
  try {
    const { stdout } = await run('scripts/deploy-tab-diff.sh', args, { cwd: process.cwd() })
    return { code: 0, out: stdout }
  } catch (err: any) {
    return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

// Provably remove the CURRENT codex pane: find the codex tab from Redux (NOT a
// stale pre-restart terminalId) and click its tab-strip close button
// (data-tab-id + role=button name=/close/, exactly as tab-management.spec.ts:61-70).
async function closeCodexTab(page: import('@playwright/test').Page, harness: TestHarness) {
  const before = await harness.getTabCount()
  const st = await harness.getState()
  const codexTab = st.tabs.tabs.find((t: any) => t.mode === 'codex')
  expect(codexTab, 'a codex tab exists to close').toBeTruthy()
  await page.locator(`[data-tab-id="${codexTab.id}"]`).getByRole('button', { name: /close/i }).click()
  await harness.waitForTabCount(before - 1)  // proves the pane is gone
}

test.describe('deploy tab-diff ritual (rust only, ephemeral server)', () => {
  test('verify passes when identity survives a restart and fails loudly + remediates when it does not', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust') // rust-only guard (also in every match-all project's testIgnore)
    test.setTimeout(240_000)
    const server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {
        env: { /* fake codex CLI wiring copied from codex-terminal-bounce-rust.spec.ts */ },
        setupHome: async (homeDir) => { /* config seeding copied from the same spec */ },
      },
    })
    const info = await server.start()
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-'))
    const before = path.join(tmpDir, 'before.json')
    const before2 = path.join(tmpDir, 'before2.json')
    const auth = { 'x-auth-token': info.token, 'content-type': 'application/json' }
    const capturedAtOf = async (f: string) => JSON.parse(await fs.readFile(f, 'utf8')).capturedAt
    const codexPaneSession = async (harness: TestHarness) => {
      const st = await harness.getState()
      const tab = st.tabs.tabs.find((t: any) => t.mode === 'codex')
      if (!tab) return null
      return (await harness.getPaneLayout(tab.id))?.content?.sessionRef?.sessionId ?? null
    }
    try {
      const harness = await connect(page, info)
      // one identity pane + one plain pane. Unwrap the {status,data,message} envelope.
      const codex = await (await fetch(`${info.baseUrl}/api/tabs`, { method: 'POST', headers: auth,
        body: JSON.stringify({ mode: 'codex', name: 'work',
          sessionRef: { provider: 'codex', sessionId: SESSION_ID } }) })).json()
      expect(codex.data.terminalId).toBeTruthy()
      await fetch(`${info.baseUrl}/api/tabs`, { method: 'POST', headers: auth,
        body: JSON.stringify({ mode: 'shell', name: 'sh' }) })
      // wait for a persisted generation carrying both tabs (union recordCount)
      await expect(async () => {
        const r = await (await fetch(`${info.baseUrl}/api/tabs-sync/snapshots`, { headers: auth })).json()
        expect(r.devices.some((d: any) => d.recordCount >= 2)).toBe(true)
      }).toPass({ timeout: 30_000 })

      // -- CAPTURE --
      expect((await tabDiff(['capture', '--url', info.baseUrl, '--token', info.token, '--out', before])).code).toBe(0)

      // -- HAPPY PATH: restart, wait for WS reconnect (getWsReadyState), respawn + fresh push --
      await server.restart()
      await expect(async () => {
        const ready = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(ready).toBe('ready')
      }).toPass({ timeout: 60_000 })
      const beforeCap = await capturedAtOf(before)
      await expect(async () => {
        expect(await codexPaneSession(harness)).toBe(SESSION_ID)     // respawned, same identity (Redux)
        const terms = await (await fetch(`${info.baseUrl}/api/terminals`, { headers: auth })).json()
        expect(terms.some((t: any) => t.mode === 'codex')).toBe(true) // RAW array; codex has no sessionRef here
        const r = await (await fetch(`${info.baseUrl}/api/tabs-sync/snapshots`, { headers: auth })).json()
        expect(r.devices.some((d: any) => d.generations[0]?.capturedAt > beforeCap)).toBe(true)
      }).toPass({ timeout: 60_000 })
      const ok = await tabDiff(['verify', '--url', info.baseUrl, '--token', info.token, '--before', before])
      expect(ok.out).toContain('OK: every previously-live pane came back')
      expect(ok.code).toBe(0)

      // -- FAILURE PATH: capture the (good) state, then PROVABLY remove the codex pane --
      expect((await tabDiff(['capture', '--url', info.baseUrl, '--token', info.token, '--out', before2])).code).toBe(0)
      await closeCodexTab(page, harness)                              // codex tabKey leaves the next push
      const before2Cap = await capturedAtOf(before2)
      await expect(async () => {  // wait until the codex-less push lands
        const r = await (await fetch(`${info.baseUrl}/api/tabs-sync/snapshots`, { headers: auth })).json()
        expect(r.devices.some((d: any) => d.generations[0]?.capturedAt > before2Cap)).toBe(true)
      }).toPass({ timeout: 30_000 })

      const bad = await tabDiff(['verify', '--url', info.baseUrl, '--token', info.token, '--before', before2])
      expect(bad.code).not.toBe(0)                                   // exits non-zero
      expect(bad.out).toContain('TAB-DIFF DIVERGENCE')               // loud
      expect(bad.out).toMatch(/MISSING|FRESH \(identity lost\)/)     // names the category
      expect(bad.out).toContain('scripts/restore-tabs.sh')           // prints the remediation
      expect(bad.out).toMatch(/--generation \d+/)                    // last-good generation, not 0

      // -- EXECUTE the printed remediation (substituting the real token) and prove
      //    the missing codex session comes back. Only 1 browser connected -> the
      //    restore connection-gate allows it. --
      const gen = bad.out.match(/--generation (\d+)/)![1]
      const dev = bad.out.match(/--device (\S+)/)![1]
      const rem = await run('scripts/restore-tabs.sh',
        ['--url', info.baseUrl, '--token', info.token, '--device', dev, '--generation', gen],
        { cwd: process.cwd() })
      expect(rem.stdout).toContain('failed=0')
      await expect(async () => {
        expect(await codexPaneSession(harness)).toBe(SESSION_ID)      // the session identity returned
      }).toPass({ timeout: 20_000 })
    } finally {
      await server.stop()
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
```

(`closeCodexTab` above is the deterministic simulation: it finds the CURRENT
codex tab from Redux — never a stale pre-restart `terminalId` — and clicks its
tab-strip close button (`[data-tab-id="…"]` + `getByRole('button',{name:/close/i})`,
verified in `TabBar.tsx` / `tab-management.spec.ts:61-70`), then waits for the
tab count to drop so the removal is proven. Do NOT use `DELETE /api/terminals/{id}`
— it only writes a `{deleted:true}` settings override and neither kills the PTY
nor closes the tab, so it cannot simulate pane loss.)

- [ ] **Step 2: Register the spec — BOTH the `rust-chromium` `testMatch` AND the shared `RUST_ONLY_SPECS` testIgnore list**

Append to `rust-chromium`'s `testMatch`:
```ts
        // CONTINUITY TRIO deliverable 3: deploy tab-diff ritual acceptance
        // (capture -> restart -> verify OK; identity loss fails loudly + remediates).
        /deploy-tab-diff-rust\.spec\.ts$/,
```

AND append the same regex to the shared `RUST_ONLY_SPECS` array (introduced in
Task 5, extended in Task 7) so it stays out of every match-all project:
```ts
const RUST_ONLY_SPECS = [
  /snapshot-restore-rust\.spec\.ts$/,
  /continuity-smoke\.spec\.ts$/,
  /deploy-tab-diff-rust\.spec\.ts$/,       // <-- add now
]
```

Confirm the spec is NOT listed under `[chromium]`:
`npx playwright test --config test/e2e-browser/playwright.config.ts --list | grep deploy-tab-diff-rust` (must show ONLY `[rust-chromium]`).

- [ ] **Step 3: Run twice**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium deploy-tab-diff-rust.spec.ts --repeat-each=2`
Expected: 2 passed.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): deploy tab-diff ritual acceptance -- OK across a clean restart, loud red on identity loss

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Final verification (whole system, before handing to review)

- [ ] `cargo test -p freshell-ws -p freshell-server -p freshell-freshagent -p freshell-terminal` — green
- [ ] `cargo clippy --workspace` + `cargo fmt --all -- --check` — clean on touched files
- [ ] `npm run test:status`, then `npm run test:vitest -- test/e2e-browser/vitest.config.ts` equivalent for helper tests if helpers changed (`npm run test:e2e:helpers`)
- [ ] `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium snapshot-restore-rust.spec.ts deploy-tab-diff-rust.spec.ts codex-terminal-bounce-rust.spec.ts remote-tab-linkage-rust.spec.ts restore-matrix.spec.ts` — green (no regression in the neighboring identity specs)
- [ ] `npm run smoke:continuity` — green, ≤ ~4 min
- [ ] `git log --oneline 136b9e94..HEAD` shows the three deliverables as ordered, focused series
- [ ] `git diff 136b9e94..HEAD --stat -- server/ shared/ src/ dist/` is EMPTY (frozen paths untouched)

## Self-review record (spec vs plan)

1. **Spec coverage:** D1 sessionRef persisted (Task 1 — client already pushes it, records opaque; test pins it), per-(device,client) generations pruned to 5 with global device cap + oversize skip + injective containment-safe device-id encoding (traversal/empty/collision tests) + coherent cross-client `read_device_union` under `~/.freshell/tabs-snapshots/` (Task 1), restore drives the REAL create pipeline via the full module path with envelope `.data` unwrapping, preflight identity-loss guard, marker idempotency, and a connected-browser broadcast gate (Task 3), REST read surface (union + point-in-time) + one-command operator script (Tasks 2-4), e2e round-trip with mixed kinds + codex identity via `getPaneLayout` + fresh-context wipe + bystander broadcast-gate proof + rerun idempotency (Task 5). D2 real server + real CLIs (Task 7), seeded fixtures per real discovery layout with probes (Task 6), sidebar + REST open paths, restart-without-reload (getWsReadyState wait) then reload, tab-count/session-id(pane)/MARKER(search `.matches`) assertions with corrected per-CLI fallback rule, outside default matrix (`smoke:continuity` + `RUST_ONLY_SPECS` testIgnore), FAIL@`136b9e94~1` / PASS@HEAD evidence with `PIPESTATUS[0]` (Task 8). D3 capture/verify GETs-only script (RAW `/api/terminals` array) with before-state liveness gating + vacuous-OK guard + last-good `--generation` remediation (Task 9), e2e pass + loud-fail + executed-remediation acceptance with a deterministic `closeCodexTab` failure sim (Task 10).
2. **Deferral audit (1b):** one intentional, LOUD limitation: restore recreates `terminal`/`browser`/`editor` panes and reports `fresh-agent` panes as `skipped: unsupported-kind` (the REST pipeline has no agent-resume shape — `lib.rs:1158-1171`), surfaced in the response, the operator script, and the module docs — not silent. A terminal pane whose captured `sessionRef.provider != mode` is reported `failed: session-identity-mismatch` (never spawned as a fresh session labelled "restored"). No requirement was moved to "future work".
3. **Placeholder scan:** remaining `<...>` tokens are run-time values (uuids, shas, captured output) or explicit mirror-this-file instructions pointing at a named existing spec/block — no TBD/TODO steps.
4. **Type consistency:** `with_persist_dir`/`list_generations`(3-arg)/`read_generation`/`read_device_union`/`list_snapshot_devices`/`encode_device_id`/`MAX_SNAPSHOT_{GENERATIONS,DEVICES,BYTES}` names match across Tasks 1-3; `TabsSnapshotsState{auth_token, snapshots_dir, fresh_agent, screenshots}` matches Tasks 2-3; the create envelope `{status,data,message}` `.data` unwrap is used uniformly (Tasks 3,5,10); `restore-tabs.sh` flags (incl. `--generation`) match the remediation printed in Task 9 and executed in Task 10; `RUST_ONLY_SPECS` testIgnore spans Tasks 5/7/10; `FRESHELL_E2E_RUST_SERVER_BIN` matches Tasks 6 and 8.
