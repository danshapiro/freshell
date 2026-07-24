# Continuity Safety Trio Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Give freshell's Rust port a continuity safety net: durable tabs-sync snapshot generations with a one-command restore, a real-CLI continuity smoke test (single wall-clock budget: **≤5 minutes**, matching the 300 s Playwright timeout) as a pre-deploy gate, and a read-only deploy tab-diff ritual script.

**Architecture:** All server work is additive in `crates/` (the client `src/`, `shared/`, and legacy `server/` are FROZEN). Deliverable 1 persists the tabs-sync registry's per-device snapshots to `~/.freshell/tabs-snapshots/` (last 5 generations per (device, client), capped at 40 files per device) and adds read + restore REST endpoints that rebuild tabs by driving the existing, proven `POST /api/tabs` create pipeline. Deliverable 2 is one Playwright scenario against the real `freshell-server` binary and the REAL `codex`/`amplifier`/`claude` CLIs, registered outside the default test matrix. Deliverable 3 is a read-only bash script (`capture`/`verify`) over the new snapshot GETs plus the existing `GET /api/terminals`, with an e2e proof that it fails loudly on identity loss.

**Tech Stack:** Rust (axum, serde_json, tokio) in `crates/freshell-ws` + `crates/freshell-server` + `crates/freshell-freshagent`; Playwright (`test/e2e-browser/`, `RustServer` harness); bash + curl + jq operator scripts.

## Current execution status

All original implementation tasks in this plan are complete in the branch
history. The checked steps and embedded code blocks below are retained as a
historical implementation transcript; they are not instructions to overwrite
the current source. From the current HEAD, use the shipped scripts under
`scripts/` and run the final verification commands rather than replaying an
obsolete red/green step or copying an embedded script body.

## Global Constraints

- Follow the repository branch model in `AGENTS.md`: start each behavior-change
  feature branch from `origin/main`, prepare and push that feature branch, ask
  for explicit approval before opening a PR, and target the PR at `main`.
  Never push behavior changes directly to `origin/main`.
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
- Beyond-legacy behavior introduced here (snapshot persistence + new endpoints) is PURELY ADDITIVE — it does not diverge from any ported behavior on any ported route. Per `port/oracle/DEVIATIONS.md`'s entry rules (an entry may be added ONLY when the original is **objectively defective**, verified `port/oracle/DEVIATIONS.md:9-16`), additive-only surface gets NO ledger entry. Do NOT add a DEVIATIONS.md row (this reverses the earlier plan's invalid `objective_defect: n/a` proposal).

## Key facts discovered (verified at HEAD `136b9e94`, worktree-relative paths)

- Tabs-sync registry: `crates/freshell-ws/src/tabs.rs` — in-memory `TabsRegistry` (`Arc<Mutex<State>>`), records held as opaque `serde_json::Value` (identity fields survive verbatim). Push handler: `crates/freshell-ws/src/terminal.rs:1610-1648` (`handle_tabs_push` → `state.tabs.replace_client_snapshot(...)`). Constructed at `crates/freshell-server/src/main.rs:274` (`let tabs = freshell_ws::tabs::TabsRegistry::new();`), shared with the REST retire beacon (`crates/freshell-server/src/boot.rs:63-93`).
- What the client pushes today (frozen `src/lib/tab-registry-snapshot.ts:15-66`): each record has `tabKey` (= `${deviceId}:${tabId}`), `tabId`, `tabName`, `status`, `revision`, `updatedAt`, `paneCount`, `panes[]`; each pane snapshot is `{paneId, kind, payload}` where terminal payload = `{mode, shell, sessionRef, codexDurability?, liveTerminal: {terminalId, serverInstanceId}?, initialCwd}` and fresh-agent payload includes `provider`, `sessionRef`, `initialCwd`. **`sessionRef {provider, sessionId}` is already pushed** — persistence must simply not drop it (records are opaque `Value`s, so it won't).
- Home resolution: `FRESHELL_HOME` else `HOME` (`crates/freshell-server/src/main.rs:16,120`); server disk state lives under `<home>/.freshell/` (`settings_store.rs:164`).
- `POST /api/tabs` (the proven create pipeline): `crates/freshell-freshagent/src/lib.rs:1150-1171` (`create_tab`; `agent` absent → `terminal_tabs::create_terminal_or_content_tab(state, body).await`); terminal path `crates/freshell-freshagent/src/terminal_tabs.rs:189-224,952-1046` — body keys `mode`, `cwd`, `name`, `sessionRef` (honored when `sessionRef.provider == mode` via `accepted_session_ref_for_mode`, `terminal_tabs.rs:82-87`), `resumeSessionId` (legacy; rejected with HTTP 400 for codex, `terminal_tabs.rs:113-133,62`), `browser: <url>`, `editor: <filePath>`.
  - **RESPONSE ENVELOPE (verified `terminal_tabs.rs:1040-1043,267` via the `ok_json`/`fail_json` helpers at `lib.rs:1106-1133`):** success is `{ "status":"ok", "data": {<ids>}, "message":"tab created" }` — NOT a flat id object. For a terminal tab `data = {tabId, paneId, terminalId}`; for a content (browser/editor) tab `data = {tabId, paneId}` (NO `terminalId`). Errors are `{ "status":"error", "message": <msg> }` at a non-2xx HTTP status (no `data` key). **Every consumer in this plan MUST unwrap `.data` (Rust: `resp_body["data"]["tabId"]`; JS: `body.data.terminalId`).**
  - Ordinary `POST /api/tabs` success broadcasts `ui.command{tab.create}` on the shared bus. Restore calls the same pipeline in deferred-delivery mode, then sends that exact typed command only through the selected screenshot-capable connection's direct sink. The terminal payload carries `paneContent.sessionRef`, so the receiving client's Redux pane gets `content.sessionRef` — the provider-agnostic same-session evidence source used by the Rust e2e specs.
  - A session-provider create carrying NEITHER `sessionRef` NOR `resumeSessionId` still SUCCEEDS and returns the normal envelope (only logs the `tab_create_missing_session_identity` WARN, target `freshell_ws::invariants`, `terminal_tabs.rs:1020-1033`). `is_session_provider_mode` = amplifier|opencode|claude|gemini|kimi (codex/shell excluded).
- REST auth: `x-auth-token` header (or cookie) — `is_authed`/`unauthorized` are `pub(crate)` in `crates/freshell-server/src/boot.rs:686,713`; import as `use crate::boot::is_authed;`.
- Live terminal registry REST: `GET /api/terminals` (`crates/freshell-server/src/terminals.rs:103,395-530`) is **BRANCHED (verified `terminals.rs:403-415`)**: with NO read-model query param it returns a **RAW JSON ARRAY** of items (`Json(Value::Array(items))`, line 414); the `{items, nextCursor, revision}` PAGED shape is returned ONLY when any of `cursor`/`priority`/`revision`/`limit` is present, AND `priority` (`"visible"|"background"`) is then REQUIRED (else HTTP 400, `terminals.rs:428-437`). **This plan uses the RAW-ARRAY form (no query params): iterate the array directly (JS `terms.filter(...)`, jq `.[]`), NEVER `terms.items`.** Each item: `terminalId`, `title`, `mode`, `sessionRef?`, `createdAt`, `lastActivityAt`, `status`, `hasClients`, `cwd?`, `lastLine`. **`sessionRef` is DELIBERATELY OMITTED for `mode == "codex"` (and `"shell"`) items (`terminals.rs:674-682`)** and is only synthesized (`{provider:mode, sessionId:resumeSessionId}`) for non-codex/non-shell modes — so codex same-session identity MUST be asserted via the Redux pane (`harness.getPaneLayout(tabId).content.sessionRef`), never via `/api/terminals`. Also `GET /api/terminals/{id}/search?query=...` (**the handler reads the `query` param — verified `terminals.rs:176`; `?q=...` is IGNORED/400, NOT a synonym**) (`terminals.rs:108,382-392`) returns `{ "matches":[{line,column,text}], "nextCursor": <string|null> }` — assert `.matches.length` (the strongest offline proof a CLI rendered text into a pane). `DELETE /api/terminals/{id}` (`terminals.rs:1018-1035`) only writes a `{deleted:true}` settings override + broadcasts `terminals.changed`; it does NOT kill the PTY or close a UI tab (do NOT use it to simulate pane loss).
- Router assembly: `crates/freshell-server/src/main.rs:620-663` (`.merge(...)` chain) — new routers merge there.
- E2e harness (verified against `codex-terminal-bounce-rust.spec.ts`, the canonical rust-only sibling): there is **NO `bootAndConnect` and NO `harnessReady` export**.
  - **EPHEMERAL-ONLY SAFETY (mandatory for every NEW spec in this plan — Tasks 5, 7, 10):** these specs MUST construct the owned Rust server DIRECTLY via `import { RustServer } from '../helpers/rust-server.js'` → `const server = new RustServer({ env, setupHome })`, NOT via `createE2eServerHandle(process.env, ...)`. Verified (`helpers/external-target.ts:88-105`): `createE2eServerHandle` returns an `ExternalServer` pointing at `FRESHELL_E2E_TARGET_URL` whenever that env var is set — REGARDLESS of `kind:'rust'` — and `ExternalServer` has NO `restart()` (`external-target.ts:38-46`) and would let these specs create tabs / restore / restart against a live server (e.g. the user's :3002). `new RustServer({...})` always spawns a throwaway binary on an ephemeral port with a `mkdtemp` HOME (`rust-server.ts:231-260`), so it can never touch an external target. `RustServerOptions` = `{ env?, setupHome?, token?, homeDir?, ... }` (`rust-server.ts:209-223`); `env`/`setupHome` are exactly what the sibling passed through `construct`.
  - Boot: `const server = new RustServer({ env, setupHome }); const info = await server.start()`. `server.restart()` exists (same home/port/token; browser WS auto-reconnects), `server.stop()` tears down. `info: TestServerInfo` = `{port, baseUrl, wsUrl, token, configDir, homeDir, logsDir, debugLogPath, pid, runtimeRoot}` (`helpers/test-server.ts:14-25`). Keep the in-body `expect(e2eServerKind).toBe('rust')` guard so the spec only runs under the `rust-chromium`/`continuity-smoke` projects (the fixture-default `'legacy'` fails it elsewhere); the guard is orthogonal to construction, which is always `new RustServer(...)`.
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
  - **Restore identity/idempotency substrate:** the REST `POST /api/tabs` create path does NOT synchronously upsert `TerminalIdentityRegistry` for codex (only the WS `terminal.create` path does, `terminal.rs:1193`; REST codex identity is never written there — `terminal_tabs.rs:778-791` documents this gap). So post-create identity CANNOT be re-verified via that registry for codex. Restore therefore proves identity by (i) a STRICT PREFLIGHT that rejects any terminal pane whose snapshot `sessionRef` is present but is not a valid object with a nonempty `sessionId` AND `provider == mode` (a malformed/partial ref is a reported FAILURE, never silently dropped; the create pipeline's `accepted_session_ref_for_mode` acceptance is deterministic, so a pane that passes preflight is spawned WITH its session), and (ii) the response-envelope success check. Idempotency uses a per-device on-disk restore marker keyed by the snapshot's stable content id + PANE-level restored keys (Task 3), not the live registry.
  - **Connected-browser gate for restore:** `freshell_ws::screenshot::ScreenshotBroker` registers each `uiScreenshotV1` socket by connection id with a direct sink. Under the restore lock, restore atomically snapshots the count and selects the id only when exactly one capable client exists; it refuses ordinary restore at 0 or >1. Both `tab.create` and the screenshot acknowledgement fence target that same id, and results from other connections are ignored. `force:true` overrides the count gate without broadcasting; `dryRun` creates nothing but still reads and classifies marker state.
  - Restart-respawn-with-identity (Task 10 happy path, Task 7 disruption leg) is already proven end-to-end by the committed-green `codex-terminal-bounce-rust.spec.ts` (reconnect → new terminalId → re-spawned argv contains `resume <sessionId>`; same-session asserted via `harness.getPaneLayout(tabId).content.sessionRef`, argv via the fake-codex `FAKE_CODEX_ARGV_LOG`).

## Scope check

Three deliverables, one plan: they share one subsystem (tabs-sync identity continuity) and Deliverables 2 and 3 consume Deliverable 1's endpoints. Each deliverable is its own independently landable commit series with its own test coverage, executed strictly in order 1 → 2 → 3; Task 10 is whole-system coverage (capture → restart → verify against the restore remediation).

## File structure

| File | Action | Responsibility |
|---|---|---|
| `crates/freshell-ws/src/tabs_persist.rs` | Create | Snapshot generation persistence: write + prune (per-client, global-per-device, device-count caps) + read helpers + content-id digest + tests. Lives in its OWN module so `tabs.rs` stays under the `port/AGENTS.md:81` 1,000-line-per-file limit |
| `crates/freshell-ws/src/tabs.rs` | Modify | Add `persist_dir` field + `with_persist_dir`; `replace_client_snapshot` calls `tabs_persist::persist_generation`. ~15 added lines only |
| `crates/freshell-ws/src/lib.rs` | Modify | `pub mod tabs_persist;` |
| `crates/freshell-server/src/main.rs` | Modify | Wire persist dir into `TabsRegistry`; merge the new snapshots router |
| `crates/freshell-server/src/tabs_snapshots.rs` | Create | REST: list/fetch snapshot generations + `POST /api/tabs-sync/restore` |
| `crates/freshell-freshagent/src/terminal_tabs.rs` | Modify | One-line visibility change: `create_terminal_or_content_tab` → `pub` |
| `scripts/restore-tabs.sh` | Create | One-command operator restore (curl+jq wrapper) |
| `scripts/deploy-tab-diff.sh` | Create | Deploy ritual: `capture` / `verify` (GETs only) |
| `test/e2e-browser/specs/snapshot-restore-rust.spec.ts` | Create | Deliverable 1 acceptance round-trip |
| `test/e2e-browser/specs/continuity-smoke.spec.ts` | Create | Deliverable 2: real-CLI continuity smoke (≤5-minute budget) |
| `test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts` | Create | Deliverable 3 acceptance (pass + loud fail) |
| `test/e2e-browser/helpers/rust-server.ts` | Modify | `FRESHELL_E2E_RUST_SERVER_BIN` override (for the historical-bug proof run) |
| `test/e2e-browser/playwright.config.ts` | Modify | Register new specs; new `continuity-smoke` project outside the default matrix |
| `package.json` | Modify | `smoke:continuity` npm script |
| `docs/plans/2026-07-22-continuity-smoke-evidence.md` | Create | Captured FAIL@`136b9e94~1` / PASS@HEAD outputs |

---

## DELIVERABLE 1 — Snapshot generations + one-command restore

### Task 1: Persist tabs-sync snapshot generations to disk

**Files:**
- Create: `crates/freshell-ws/src/tabs_persist.rs` (ALL persistence code + tests; a NEW module so `tabs.rs` — 743 lines today — stays under the `port/AGENTS.md:81` 1,000-line-per-file limit)
- Modify: `crates/freshell-ws/src/lib.rs` (add `pub mod tabs_persist;` after `pub mod tabs;`)
- Modify: `crates/freshell-ws/src/tabs.rs` (~15 lines: `persist_dir` field, `with_persist_dir`, one call to `tabs_persist::persist_generation`)
- Modify: `crates/freshell-ws/src/terminal.rs` (~10 lines: run the `replace_client_snapshot` call in `handle_tabs_push` inside `tokio::task::spawn_blocking` so the blocking persistence filesystem cycle never runs on a Tokio worker — see Step 3b)
- Modify: `crates/freshell-ws/Cargo.toml` (add `sha2 = "0.10"` under `[dependencies]` — the digest below needs a real 256-bit hash; the crate is ALREADY in the workspace lockfile via `crates/freshell-terminal/Cargo.toml:36`, so this pulls in nothing new. Add `tempfile = "3"` under `[dev-dependencies]` if not already present)

**Interfaces:**
- Consumes: existing `TabsRegistry::replace_client_snapshot` (`tabs.rs:107-214`; params are all `&str` + `snapshot_revision: i64` + `mut records: Vec<Value>`; `open_records` is computed at `tabs.rs:129-133` and MOVED into `ClientOpenSnapshot.records` at `tabs.rs:191-198`; the mutex guard `state` has NO enclosing block and lives to end-of-fn; `now = now_ms()` is available; the idempotent same-revision early-return is `tabs.rs:152-162`).
- Directory layout (per-device AND per-client, so concurrent browser clients sharing one `deviceId` never overwrite/prune each other — fixes the "last-writer-wins recovery drops other clients' tabs" defect): `<root>/<enc(deviceId)>/<enc(clientInstanceId)>-<capturedAt:020>-r<revision:012>.json`. `enc()` is INJECTIVE + containment-safe **and escapes `-`** (below), so the encoded client id contains NO hyphen and the FIRST `-` in a filename is always the field delimiter — client `a` can never prefix-match a file owned by client `a-b` (real client ids are `client-<base36>-<base36>`, `src/store/tabRegistrySync.ts:38-40`, so hyphens are the common case). The revision is zero-padded and the filename carries the client tiebreaker — so two clients at the same revision in the same millisecond target DISTINCT files and `r9` sorts before `r10`.
- Retention (documented, TRULY global — every axis is bounded so an authenticated client rotating its per-window `clientInstanceId` cannot exhaust disk):
  - `MAX_SNAPSHOT_GENERATIONS = 5` files PER (device,client) (oldest pruned).
  - **`MAX_SNAPSHOT_FILES_PER_DEVICE = 40` files across ALL clients within one device dir** — the NEW global-within-device cap (fixes the critical unbounded-client-fan-out defect). After the per-client prune, if a device dir still exceeds this cap, evict the globally OLDEST files (by parsed `capturedAt`, oldest-client-prefix-first) until at/under the cap. This bounds one device to ≤ 40 files regardless of how many client ids it cycles through.
  - `MAX_SNAPSHOT_DEVICES = 64` device directories (persisting into a new device beyond the cap evicts the least-recently-written device dir first).
  - A generation whose pretty-JSON exceeds `MAX_SNAPSHOT_BYTES = 1_048_576` is skipped (WARN, not written).
  - **Hard global bound:** total disk ≤ `MAX_SNAPSHOT_DEVICES × MAX_SNAPSHOT_FILES_PER_DEVICE × MAX_SNAPSHOT_BYTES` = 64 × 40 × 1 MiB ≈ 2.5 GiB, INDEPENDENT of client-id churn. This restores (and hardens beyond) the retention protection the module doc (`tabs.rs:16-26`) notes the legacy store had and this port had dropped.
- Produces (later tasks rely on these EXACT names/signatures; all live in `freshell_ws::tabs_persist`):
  - `TabsRegistry::with_persist_dir(dir: std::path::PathBuf) -> TabsRegistry` (on `tabs.rs`, delegates persistence to `tabs_persist`).
  - `pub const MAX_SNAPSHOT_GENERATIONS: usize = 5;` / `pub const MAX_SNAPSHOT_FILES_PER_DEVICE: usize = 40;` / `pub const MAX_SNAPSHOT_DEVICES: usize = 64;` / `pub const MAX_SNAPSHOT_BYTES: usize = 1_048_576;`
  - `pub fn encode_device_id(id: &str) -> Option<String>` — injective, containment-safe folder/name segment (keeps ONLY `[A-Za-z0-9]`, escapes every other byte — INCLUDING `-` as `_2d` and `_` as `_5f` — as `_<2-lower-hex>`; returns `None` for an EMPTY id). Output contains no `.`/`/`/`-`, so `..`, `.`, `a/b` can never resolve outside `<root>` and the `-` delimiter is unambiguous; distinct ids never collide (`"dev a/1" -> "dev_20a_2f1"` ≠ `"dev_a_1" -> "dev_5fa_5f1"`; `"a" -> "a"` ≠ `"a-b" -> "a_2db"`).
  - `pub fn snapshot_content_id(snap: &serde_json::Value) -> String` — the stable canonical digest of the `records` array, used for the restore marker's logical `sourceId`.
  - `pub fn snapshot_generation_id(snap: &serde_json::Value) -> String` — the stable canonical digest of the full generation document, used as the immutable `generationId` in listings, restore-by-id, and component bundles. Two clients/files with equal records therefore remain independently addressable.
  - **Fail-loud reads (error taxonomy, `:480`):** every reader returns `std::io::Result<...>` so the REST layer can distinguish "no backup" (`Ok(None)`/`Ok(empty)` → 404/empty) from "backup is present but unreadable/corrupt" (`Err` → 500 + structured log with `path` + `error`). A missing device/root directory is ABSENCE (`Ok`); a `read_dir` failure on an existing directory, or a file that exists but fails to read or parse, is an ERROR (`Err`) — a corrupt backup is NEVER silently treated as missing.
  - `pub fn list_snapshot_devices(dir: &std::path::Path) -> std::io::Result<Vec<String>>` — the RAW `deviceId`s (read from each device's stored `deviceId`, NOT the encoded folder name), sorted, deduped. `Err` on an unreadable dir or a corrupt device file.
  - `pub fn list_generations(dir: &std::path::Path, device_id: &str, client_instance_id: &str) -> Vec<std::path::PathBuf>` (one client, newest first; a pure filename listing — no parse — so it stays infallible and returns an empty Vec when the dir is absent).
  - `pub fn read_device_union(dir: &std::path::Path, device_id: &str) -> std::io::Result<Option<serde_json::Value>>` — the COHERENT device recovery snapshot: the union of each client's NEWEST generation's records, deduped by `tabKey` keeping the highest `(revision, updatedAt)`; **the tie-break when BOTH revision and updatedAt are equal is the SOURCE generation's `(clientInstanceId, generationId)`** (which differs per candidate — the tab key does NOT, so it can never resolve a tie), applied by the SHARED `union_of_newest_per_client` function used by BOTH this and `read_device_overview` so the two paths can never disagree (`:570`). `capturedAt`/`snapshotRevision` = the max across clients; `deviceLabel`/`deviceId` taken from the client whose newest generation has the max `(capturedAt, generationId)` (deterministic, not iteration-order-dependent). `Ok(None)` when the device has no generations; `Err` on IO/parse failure.
  - `pub fn read_generation(dir: &std::path::Path, device_id: &str, generation: usize) -> std::io::Result<Option<serde_json::Value>>` — the Nth-newest single point-in-time FILE across the merged (all-clients) `capturedAt`-then-filename-sorted list (0 = newest single file). A SINGLE-CLIENT file, NOT a coherent device-wide generation. `Ok(None)` when out of range, `Err` on IO/parse.
  - `pub fn read_generation_by_id(dir: &std::path::Path, device_id: &str, generation_id: &str) -> std::io::Result<Option<serde_json::Value>>` — the single point-in-time file whose full-document `snapshot_generation_id` equals `generation_id`. `Ok(None)` when no file matches, `Err` on IO/parse.
  - `pub fn read_generations_union_by_ids(dir: &std::path::Path, device_id: &str, ids: &[String]) -> std::io::Result<Option<serde_json::Value>>` — the union of the SPECIFIC generations named by `ids` (the IMMUTABLE multi-client bundle the deploy capture records, `:2621`), via the SHARED union routine. `Ok(None)` when none match, `Err` on IO/parse. The deploy remediation restores THIS (never a single-client `generationId`).
  - `pub fn read_device_overview(dir: &std::path::Path, device_id: &str) -> std::io::Result<Option<(serde_json::Value, Vec<serde_json::Value>)>>` — a SINGLE directory scan returning `(union, generations_meta)` where each meta is `{generation, generationId, capturedAt, snapshotRevision, deviceLabel, clientInstanceId, recordCount}` newest-first. The list endpoint (Task 2) calls THIS once per device instead of `read_generation` per index (fixes the quadratic re-scan/re-parse DoS). `Ok(None)` when absent, `Err` on IO/parse.
  - `pub(crate) fn persist_generation(dir, server_instance_id, device_id, device_label, client_instance_id, snapshot_revision, open_records: &[Value], captured_at: i64)` — a FREE function (all args explicit incl. `captured_at`, so tests inject deterministic timestamps directly), called only within `freshell-ws` (from `tabs.rs` and these tests). Runs the ENTIRE read-plan-mutate filesystem cycle (orphan-`.tmp` sweep → cap accounting → atomic write → prune → eviction) under ONE process-wide persistence mutex (`:678`), so concurrent pushes to the same OR different devices can never race directory enumeration, eviction, or `remove_dir_all`. Enforces oversize/per-client/global-per-device/device-count caps; deletion/eviction failures are LOGGED (never `let _ =`-ignored); orphaned `.tmp` files are swept AND counted toward caps before cap math. Best-effort: a persistence failure WARNs, never fails the push. Called only from inside `tokio::task::spawn_blocking` (see Step 3b).
  - Generation file JSON: `{deviceId, deviceLabel, clientInstanceId, serverInstanceId, snapshotRevision, capturedAt, records: [...open records, verbatim, post-identity-stamping]}`.

- [x] **Step 1: Write the failing tests**

Create the `#[cfg(test)] mod tests` at the bottom of the NEW `crates/freshell-ws/src/tabs_persist.rs` (it does NOT share `tabs.rs`'s test helpers, so define local ones). Tests that need to PIN `capturedAt` call the free `persist_generation` directly with an explicit `captured_at` (deterministic — no reliance on `now_ms()` producing distinct millis); tests that exercise the full push path use `TabsRegistry::with_persist_dir`.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::tabs::TabsRegistry;
    use serde_json::{json, Value};

    fn open_record(tab_key: &str, tab_name: &str, updated_at: i64) -> Value {
        json!({ "tabKey": tab_key, "tabId": tab_key, "tabName": tab_name, "status": "open",
                "revision": updated_at, "updatedAt": updated_at, "paneCount": 0, "panes": [] })
    }
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
    // Direct deterministic write (explicit captured_at + revision).
    fn put(dir: &std::path::Path, device: &str, client: &str, rev: i64, captured: i64, recs: Vec<Value>) {
        persist_generation(dir, "srv-1", device, "Dev", client, rev, &recs, captured);
    }
    // Result-unwrapping helpers so the tests read cleanly (readers are fail-loud).
    fn union(dir: &std::path::Path, device: &str) -> Option<Value> {
        read_device_union(dir, device).expect("read_device_union io")
    }
    fn gen_n(dir: &std::path::Path, device: &str, n: usize) -> Option<Value> {
        read_generation(dir, device, n).expect("read_generation io")
    }
    fn gen_by_id(dir: &std::path::Path, device: &str, id: &str) -> Option<Value> {
        read_generation_by_id(dir, device, id).expect("read_generation_by_id io")
    }
    fn devices(dir: &std::path::Path) -> Vec<String> {
        list_snapshot_devices(dir).expect("list_snapshot_devices io")
    }

    #[test]
    fn persisted_generation_written_with_session_ref_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
        reg.replace_client_snapshot("srv-1", "dev a/1", "Device A", "client-a1", 1,
            vec![codex_pane_record("dev-a:tab-1", "abc-123", 1000)]).unwrap();
        let gens = list_generations(dir.path(), "dev a/1", "client-a1");
        assert_eq!(gens.len(), 1);
        let snap = union(dir.path(), "dev a/1").expect("newest generation");
        assert_eq!(snap["deviceId"], "dev a/1");
        assert_eq!(snap["snapshotRevision"], 1);
        assert_eq!(snap["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"], "abc-123");
        // list_snapshot_devices returns the RAW id, not the encoded folder name.
        assert_eq!(devices(dir.path()), vec!["dev a/1".to_string()]);
    }

    #[test]
    fn encode_id_is_injective_containment_safe_escapes_hyphen_and_rejects_empty() {
        // No `.`, `/`, or `-` survives -> no traversal, no shared-dir collapse,
        // and `-` is reserved as the filename field delimiter.
        for raw in ["..", ".", "../../etc", "a/b", "a-b", "", "  "] {
            if let Some(enc) = encode_device_id(raw) {
                assert!(!enc.contains('.') && !enc.contains('/') && !enc.contains('\\') && !enc.contains('-'),
                    "{raw} -> {enc}");
            }
        }
        assert_eq!(encode_device_id(""), None, "empty id is rejected (never persisted)");
        assert_ne!(encode_device_id("dev a/1"), encode_device_id("dev_a_1"));
        assert_ne!(encode_device_id("a"), encode_device_id("a-b")); // hyphen collision pair maps apart
        // Containment incl. a NESTED external traversal id: `../../escape/deep`
        // resolves to a SINGLE direct child of <root> and writes nothing above it.
        // (Scan only <root> and its immediate parent, never the wider /tmp tree,
        // so a sibling test's files can't make this flaky.)
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let reg = TabsRegistry::with_persist_dir(root.to_path_buf());
        reg.replace_client_snapshot("srv", "../../escape/deep", "x", "c1", 1,
            vec![open_record("t:1", "t", 1)]).unwrap();
        // The encoded dir is a DIRECT child of <root> (parent == root), so it
        // cannot escape; and <root> has exactly ONE device subdir.
        let device_dir = device_dir_for(root, "../../escape/deep").unwrap();
        assert_eq!(device_dir.parent(), Some(root));
        let subdirs: Vec<_> = std::fs::read_dir(root).unwrap().flatten()
            .map(|e| e.path()).filter(|p| p.is_dir()).collect();
        assert_eq!(subdirs.len(), 1, "traversal id must not fan out or escape: {subdirs:?}");
        // Nothing landed directly in <root>'s parent as a stray *.json.
        let parent = root.parent().unwrap();
        let stray: Vec<_> = std::fs::read_dir(parent).unwrap().flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "json"))
            .collect();
        assert!(stray.is_empty(), "traversal id wrote a stray json into the root's parent: {stray:?}");
        assert_eq!(devices(root), vec!["../../escape/deep".to_string()]);
    }

    #[test]
    fn client_hyphen_ownership_is_unambiguous() {
        // Real client-id shapes: `client-a` is a PREFIX substring of `client-a-b`.
        // With `-` escaped, list_generations/prune for one never selects the other.
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "dev", "client-a", 1, 1000, vec![open_record("dev:t1", "a", 1)]);
        put(dir.path(), "dev", "client-a-b", 1, 1001, vec![open_record("dev:t2", "b", 1)]);
        assert_eq!(list_generations(dir.path(), "dev", "client-a").len(), 1,
            "client-a must NOT match client-a-b's files");
        assert_eq!(list_generations(dir.path(), "dev", "client-a-b").len(), 1);
    }

    #[test]
    fn generations_pruned_per_client_padded_ordering() {
        // EQUAL capturedAt for every write so ONLY the zero-padded revision can
        // decide order -> this actually proves r9 < r10 (not timestamp order).
        let dir = tempfile::tempdir().unwrap();
        for rev in 1..=(MAX_SNAPSHOT_GENERATIONS as i64 + 7) {
            put(dir.path(), "dev", "c1", rev, 5000, vec![open_record("dev:t1", "x", rev)]);
        }
        let gens = list_generations(dir.path(), "dev", "c1");
        assert_eq!(gens.len(), MAX_SNAPSHOT_GENERATIONS);
        assert_eq!(gen_n(dir.path(), "dev", 0).unwrap()["snapshotRevision"],
            MAX_SNAPSHOT_GENERATIONS as i64 + 7);
        let oldest = gen_n(dir.path(), "dev", MAX_SNAPSHOT_GENERATIONS - 1).unwrap();
        assert_eq!(oldest["snapshotRevision"], (MAX_SNAPSHOT_GENERATIONS as i64 + 7) - 4);
    }

    #[test]
    fn union_newest_per_client_tiebreak_is_deterministic_on_equal_capturedat() {
        // Same client, two files at the SAME capturedAt, revisions 9 and 10 ->
        // the newest-per-client pick must be r10 (padded revision, then filename),
        // never arbitrary read_dir order.
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "dev", "c1", 9, 7000, vec![codex_pane_record("dev:t", "sess-9", 9)]);
        put(dir.path(), "dev", "c1", 10, 7000, vec![codex_pane_record("dev:t", "sess-10", 10)]);
        let u = union(dir.path(), "dev").unwrap();
        assert_eq!(u["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"], "sess-10");
    }

    #[test]
    fn content_id_is_key_order_independent_and_collision_distinct() {
        // `preserve_order` is enabled workspace-wide, so two records with the SAME
        // fields inserted in a DIFFERENT key order serialize to different bytes;
        // canonicalization must make them hash IDENTICALLY, and distinct content
        // must still hash apart (a real 256-bit digest, no accidental collisions).
        let a = json!({ "records": [ { "tabKey": "k", "revision": 1, "updatedAt": 2 } ] });
        let mut rec = serde_json::Map::new();
        rec.insert("updatedAt".into(), json!(2));
        rec.insert("revision".into(), json!(1));
        rec.insert("tabKey".into(), json!("k"));
        let b = json!({ "records": [ Value::Object(rec) ] });
        assert_eq!(snapshot_content_id(&a), snapshot_content_id(&b),
            "key insertion order must not change the content id");
        assert_eq!(snapshot_content_id(&a).len(), 32, "128-bit digest = 32 hex chars");
        let c = json!({ "records": [ { "tabKey": "k", "revision": 1, "updatedAt": 3 } ] });
        assert_ne!(snapshot_content_id(&a), snapshot_content_id(&c), "distinct content hashes apart");
    }

    #[test]
    fn union_exact_tie_equal_rev_and_updatedat_resolves_deterministically() {
        // Same tabKey, EQUAL revision AND equal updatedAt AND equal capturedAt but
        // different owning client + different sessionRef -> the (revision,
        // updatedAt) rank ties; the winner is decided by the SOURCE
        // (clientInstanceId, generationId) and MUST be identical on every read and
        // identical between the union and overview paths (they share one routine).
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "dev", "clientA", 5, 6000, vec![codex_pane_record("dev:shared", "sess-A", 5)]);
        put(dir.path(), "dev", "clientB", 5, 6000, vec![codex_pane_record("dev:shared", "sess-B", 5)]);
        let winner = union(dir.path(), "dev").unwrap()
            ["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"].clone();
        assert!(winner == "sess-A" || winner == "sess-B");
        for _ in 0..20 {
            assert_eq!(union(dir.path(), "dev").unwrap()
                ["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"], winner,
                "exact-tie winner must be deterministic across reads");
        }
        let (ov_union, _) = read_device_overview(dir.path(), "dev").unwrap().unwrap();
        assert_eq!(ov_union["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"], winner,
            "overview and union paths must agree on the tie winner");
    }

    #[test]
    fn two_clients_same_device_equal_capturedat_union_keeps_both() {
        // FORCE equal capturedAt across the two clients.
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "dev", "clientA", 1, 8000, vec![codex_pane_record("dev:tabA", "sess-A", 1)]);
        put(dir.path(), "dev", "clientB", 1, 8000, vec![codex_pane_record("dev:tabB", "sess-B", 1)]);
        assert_eq!(list_generations(dir.path(), "dev", "clientA").len(), 1);
        assert_eq!(list_generations(dir.path(), "dev", "clientB").len(), 1);
        let u = union(dir.path(), "dev").unwrap();
        let keys: Vec<String> = u["records"].as_array().unwrap().iter()
            .map(|r| r["tabKey"].as_str().unwrap().to_string()).collect();
        assert!(keys.contains(&"dev:tabA".to_string()) && keys.contains(&"dev:tabB".to_string()),
            "union dropped a client's tabs: {keys:?}");
    }

    #[test]
    fn union_dedupes_shared_tabkey_keeping_highest_revision() {
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "dev", "clientA", 7, 9000, vec![codex_pane_record("dev:shared", "sess-new", 7)]);
        put(dir.path(), "dev", "clientB", 3, 9000, vec![codex_pane_record("dev:shared", "sess-old", 3)]);
        let u = union(dir.path(), "dev").unwrap();
        let recs = u["records"].as_array().unwrap();
        assert_eq!(recs.len(), 1, "shared tabKey must dedupe");
        assert_eq!(recs[0]["panes"][0]["payload"]["sessionRef"]["sessionId"], "sess-new");
    }

    #[test]
    fn empty_snapshot_does_not_overwrite_last_good_generation() {
        let dir = tempfile::tempdir().unwrap();
        let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
        reg.replace_client_snapshot("srv-1", "dev", "Dev", "c1", 1,
            vec![open_record("dev:t1", "good", 1000)]).unwrap();
        reg.replace_client_snapshot("srv-1", "dev", "Dev", "c1", 2, vec![]).unwrap();
        assert_eq!(list_generations(dir.path(), "dev", "c1").len(), 1);
        assert_eq!(gen_n(dir.path(), "dev", 0).unwrap()["snapshotRevision"], 1);
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
        // Explicit ascending capturedAt -> the victim is deterministically dev-000.
        let dir = tempfile::tempdir().unwrap();
        for n in 0..=(MAX_SNAPSHOT_DEVICES) {
            let dev = format!("dev-{n:03}");
            put(dir.path(), &dev, "c1", 1, 1000 + n as i64,
                vec![open_record(&format!("{dev}:t"), "t", 1)]);
        }
        assert_eq!(devices(dir.path()).len(), MAX_SNAPSHOT_DEVICES);
        assert!(union(dir.path(), "dev-000").is_none());
        assert!(union(dir.path(), &format!("dev-{:03}", MAX_SNAPSHOT_DEVICES)).is_some());
    }

    #[test]
    fn global_per_device_cap_holds_across_rotating_client_ids() {
        // THE CRITICAL BOUND: a single device cycling many per-window client ids
        // must never accumulate more than MAX_SNAPSHOT_FILES_PER_DEVICE files.
        let dir = tempfile::tempdir().unwrap();
        for n in 0..(MAX_SNAPSHOT_FILES_PER_DEVICE * 3) {
            let client = format!("client-{n}"); // rotates every write, like a new window
            put(dir.path(), "dev", &client, 1, 1000 + n as i64,
                vec![open_record("dev:t", "t", 1)]);
        }
        let enc = encode_device_id("dev").unwrap();
        let count = std::fs::read_dir(dir.path().join(enc)).unwrap().flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json")).count();
        assert!(count <= MAX_SNAPSHOT_FILES_PER_DEVICE,
            "global-per-device file cap breached: {count} > {MAX_SNAPSHOT_FILES_PER_DEVICE}");
    }

    #[test]
    fn content_id_is_stable_and_selects_the_right_generation() {
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "dev", "c1", 1, 1000, vec![codex_pane_record("dev:t", "sess-old", 1)]);
        put(dir.path(), "dev", "c1", 2, 2000, vec![codex_pane_record("dev:t", "sess-new", 2)]);
        let old = gen_n(dir.path(), "dev", 1).unwrap();
        let id = snapshot_content_id(&old);
        // Stable: recomputing over the re-read file yields the same id.
        assert_eq!(id, snapshot_content_id(&gen_n(dir.path(), "dev", 1).unwrap()));
        // Selecting by id returns the OLD generation regardless of index shifts.
        let by_id = gen_by_id(dir.path(), "dev", &id).unwrap();
        assert_eq!(by_id["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"], "sess-old");
    }

    #[test]
    fn oversize_snapshot_is_skipped_not_written() {
        let dir = tempfile::tempdir().unwrap();
        // Seed a good generation, then an oversize push must NOT overwrite/delete it.
        put(dir.path(), "dev", "c1", 1, 1000, vec![open_record("dev:t1", "good", 1)]);
        let big = "x".repeat(MAX_SNAPSHOT_BYTES + 10);
        let mut rec = open_record("dev:t1", "big", 2);
        rec["blob"] = json!(big);
        put(dir.path(), "dev", "c1", 2, 2000, vec![rec]);
        assert_eq!(list_generations(dir.path(), "dev", "c1").len(), 1,
            "oversize generation must be skipped (WARN); last-good stays intact");
        assert_eq!(gen_n(dir.path(), "dev", 0).unwrap()["snapshotRevision"], 1);
    }

    #[test]
    fn concurrent_pushes_same_and_different_devices_stay_consistent() {
        // CONCURRENCY (`:678`): threads persist to the SAME device (distinct
        // clients) AND to DIFFERENT devices at once. The process-wide persist lock
        // must serialize the whole filesystem cycle so no read_dir/eviction race
        // corrupts state: every device stays readable and within its caps, and no
        // orphaned `.tmp` survives.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let mut handles = Vec::new();
        for n in 0..24usize {
            let root = root.clone();
            handles.push(std::thread::spawn(move || {
                let device = if n % 2 == 0 { "shared-dev".to_string() } else { format!("dev-{n}") };
                let client = format!("client-{n}");
                for rev in 1..=6i64 {
                    persist_generation(&root, "srv", &device, "D", &client, rev,
                        &[open_record(&format!("{device}:t{n}"), "t", rev)], 1000 + rev);
                }
            }));
        }
        for h in handles { h.join().unwrap(); }
        let enc = encode_device_id("shared-dev").unwrap();
        let device_dir = root.join(&enc);
        let json_count = std::fs::read_dir(&device_dir).unwrap().flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json")).count();
        assert!(json_count <= MAX_SNAPSHOT_FILES_PER_DEVICE,
            "global-per-device cap breached under concurrency: {json_count}");
        assert!(union(&root, "shared-dev").is_some(), "shared device union unreadable after concurrent writes");
        let tmp_count = std::fs::read_dir(&device_dir).unwrap().flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "tmp")).count();
        assert_eq!(tmp_count, 0, "orphaned .tmp left after concurrent writes");
    }

    #[test]
    fn orphan_tmp_is_reaped_before_cap_math() {
        // FAILURE INJECTION (`:678`): a crashed write left a `.tmp`. The next
        // persist reaps it (it never lingers outside the caps), and reading the
        // device still returns the newest good generation.
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "dev", "c1", 1, 1000, vec![open_record("dev:t", "t", 1)]);
        let enc = encode_device_id("dev").unwrap();
        let device_dir = dir.path().join(&enc);
        std::fs::write(device_dir.join(".c1-orphan.tmp"), b"partial write").unwrap();
        put(dir.path(), "dev", "c1", 2, 2000, vec![open_record("dev:t", "t", 2)]);
        let tmp = std::fs::read_dir(&device_dir).unwrap().flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "tmp")).count();
        assert_eq!(tmp, 0, "orphan .tmp must be reaped before cap math");
        assert_eq!(gen_n(dir.path(), "dev", 0).unwrap()["snapshotRevision"], 2);
    }

    #[test]
    fn union_by_ids_restores_the_multi_client_bundle_not_a_single_client() {
        // Two clients, each newest generation is one bundle COMPONENT. The
        // union-by-ids of BOTH ids yields BOTH clients' tabs (:2621); a single
        // component id yields only that client's tab.
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "dev", "clientA", 1, 1000, vec![codex_pane_record("dev:tabA", "sess-A", 1)]);
        put(dir.path(), "dev", "clientB", 1, 1001, vec![codex_pane_record("dev:tabB", "sess-B", 1)]);
        let a_id = snapshot_content_id(&gen_by_id_scan(dir.path(), "dev", "clientA"));
        let b_id = snapshot_content_id(&gen_by_id_scan(dir.path(), "dev", "clientB"));
        let both = read_generations_union_by_ids(dir.path(), "dev",
            &[a_id.clone(), b_id.clone()]).unwrap().unwrap();
        let keys: Vec<String> = both["records"].as_array().unwrap().iter()
            .map(|r| r["tabKey"].as_str().unwrap().to_string()).collect();
        assert!(keys.contains(&"dev:tabA".to_string()) && keys.contains(&"dev:tabB".to_string()),
            "bundle must union ALL components: {keys:?}");
        let only_a = read_generations_union_by_ids(dir.path(), "dev", &[a_id]).unwrap().unwrap();
        assert_eq!(only_a["records"].as_array().unwrap().len(), 1, "single component = one client only");
        assert!(read_generations_union_by_ids(dir.path(), "dev", &["nope".to_string()]).unwrap().is_none());
    }
    // Helper: the parsed generation owned by a given client (there is one each here).
    fn gen_by_id_scan(dir: &std::path::Path, device: &str, client: &str) -> Value {
        let path = list_generations(dir, device, client).into_iter().next().unwrap();
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn corrupt_generation_file_reads_as_error_not_absence() {
        // FAIL-LOUD (`:480`): a present-but-unparseable generation is an ERROR,
        // never silently treated as "no backup". A device with NO dir is genuine
        // absence (Ok(None)).
        let dir = tempfile::tempdir().unwrap();
        put(dir.path(), "dev", "c1", 1, 1000, vec![open_record("dev:t", "t", 1)]);
        let enc = encode_device_id("dev").unwrap();
        let file = std::fs::read_dir(dir.path().join(&enc)).unwrap().flatten()
            .map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "json")).unwrap();
        std::fs::write(&file, b"{ not valid json").unwrap();
        assert!(read_device_union(dir.path(), "dev").is_err(), "corrupt file -> Err, not Ok(None)");
        assert!(read_generation(dir.path(), "dev", 0).is_err());
        assert!(list_snapshot_devices(dir.path()).is_err());
        assert!(read_device_union(dir.path(), "ghost").unwrap().is_none(), "absent device is Ok(None)");
    }
}
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-ws tabs_persist` (from the worktree root)
Historical pre-implementation result: FAIL to compile — `crates/freshell-ws/src/tabs_persist.rs` does not exist yet, and `with_persist_dir`, `list_generations`, `read_generation`, `read_generation_by_id`, `read_device_union`, `read_device_overview`, `list_snapshot_devices`, `encode_device_id`, `snapshot_content_id`, `persist_generation`, and the `MAX_SNAPSHOT_*` consts are undefined. First add the deps: `sha2 = "0.10"` under `[dependencies]` (mirror `crates/freshell-terminal/Cargo.toml:36`; the digest uses `sha2::Sha256`) and `tempfile = "3"` under `[dev-dependencies]` (NOT currently present — verified; mirror the version another workspace crate pins).

- [x] **Step 3: Implement persistence**

Create `crates/freshell-ws/src/tabs_persist.rs` with the header below (all the free functions + `persist_generation` + tests). Add `pub mod tabs_persist;` to `crates/freshell-ws/src/lib.rs` (after `pub mod tabs;`). `freshell-ws` already depends on `tracing`; call it fully-qualified as `tracing::warn!` (no `use` needed).

```rust
//! On-disk tabs-sync snapshot generations (continuity trio,
//! docs/plans/2026-07-22-continuity-safety-trio.md). Split out of `tabs.rs` to
//! keep that module under the port/AGENTS.md:81 1,000-line-per-file limit.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// Max snapshot generations retained per (device, client) (oldest pruned).
pub const MAX_SNAPSHOT_GENERATIONS: usize = 5;
/// Max snapshot files retained across ALL clients within ONE device dir. The
/// global-within-device bound that makes total disk independent of client-id
/// churn (a per-window clientInstanceId rotates freely, `tabRegistrySync.ts:38`).
pub const MAX_SNAPSHOT_FILES_PER_DEVICE: usize = 40;
/// Max device directories retained (LRU-by-newest-write eviction beyond this).
pub const MAX_SNAPSHOT_DEVICES: usize = 64;
/// A generation whose pretty-JSON exceeds this is skipped (never written).
pub const MAX_SNAPSHOT_BYTES: usize = 1_048_576;

/// INJECTIVE, containment-safe folder/name segment for a device OR client id.
/// Keeps ONLY `[A-Za-z0-9]`; escapes every other byte as `_<2-lower-hex>`
/// (so `-` -> `_2d`, `_` -> `_5f`, `/` -> `_2f`, `.` -> `_2e`). The output can
/// therefore never contain `.`, `/`, `\`, or `-`, so (a) `..`, `.`, `a/b`, and
/// absolute paths collapse to a single in-`<root>` child, (b) the `-` used as
/// the filename field delimiter is UNAMBIGUOUS (an encoded client id has no
/// hyphen, so client `a` cannot prefix-match client `a-b`'s files), and (c)
/// distinct ids never collide (URL-encode-style bijection). `None` for EMPTY.
pub fn encode_device_id(id: &str) -> Option<String> {
    if id.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(id.len());
    for b in id.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' => out.push(b as char),
            _ => out.push_str(&format!("_{b:02x}")),
        }
    }
    Some(out)
}

/// Recursively rewrite `v` into a canonical form whose serialization is
/// INDEPENDENT of object key insertion order. This workspace enables
/// `serde_json`'s `preserve_order` (`Cargo.toml:33`), so two semantically-equal
/// objects built in different insertion orders otherwise serialize to different
/// bytes and hash apart. Objects → keys sorted (via `BTreeMap`); arrays recurse
/// element-wise (array ORDER is significant and preserved); scalars unchanged.
fn canonicalize(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let sorted: std::collections::BTreeMap<String, Value> =
                map.iter().map(|(k, val)| (k.clone(), canonicalize(val))).collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

/// Stable, key-order-independent, COLLISION-RESISTANT content digest of a
/// snapshot: SHA-256 over the CANONICAL serialization of its `records`, truncated
/// to 32 lower-hex chars (128 bits). Used as a generation's `generationId`, the
/// restore marker's `sourceId`, and the restore-by-id key — so nothing is ever
/// referenced by a shifting positional index, two semantically-equal records
/// hash identically regardless of key order, and distinct content never collides
/// on a recovery-selection key (a 64-bit FNV digest over raw `preserve_order`
/// bytes was too weak AND not order-stable — both defects are fixed here).
pub fn snapshot_content_id(snap: &Value) -> String {
    use sha2::{Digest, Sha256};
    let records = snap.get("records").cloned().unwrap_or(Value::Null);
    let bytes = serde_json::to_vec(&canonicalize(&records)).unwrap_or_default();
    let digest = Sha256::digest(&bytes);
    digest[..16].iter().map(|b| format!("{b:02x}")).collect() // 16 bytes = 128 bits
}

/// The device dir, guaranteed to be a direct child of `<dir>` (belt-and-suspenders
/// containment: `encode_device_id` already strips separators).
fn device_dir_for(dir: &Path, device_id: &str) -> Option<PathBuf> {
    let enc = encode_device_id(device_id)?;
    let device_dir = dir.join(&enc);
    if device_dir.parent() != Some(dir) {
        return None;
    }
    Some(device_dir)
}

/// All generation FILES for one client, newest first (filename embeds a
/// zero-padded capturedAt then a zero-padded revision, so lexicographic
/// descending == chronological descending within a client; the encoded client
/// prefix has no `-`, so `client-a` never matches `client-a-b`'s files).
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

/// Every generation file for a device across ALL clients, PARSED ONCE, newest
/// first. The single scan behind read_generation/read_generation_by_id/overview
/// (no per-index rescan). Sort: capturedAt desc, then filename desc — fully
/// deterministic even at equal capturedAt (filename embeds the padded revision).
/// FAIL-LOUD (`:480`): a MISSING device dir is absence (`Ok(empty)`); a `read_dir`
/// failure on an existing dir, or a `*.json` file that exists but cannot be read
/// or parsed, is an ERROR (`Err`) — a corrupt backup is never silently skipped.
fn all_generations_parsed(dir: &Path, device_id: &str) -> std::io::Result<Vec<(i64, PathBuf, Value)>> {
    let Some(device_dir) = device_dir_for(dir, device_id) else { return Ok(Vec::new()); };
    let entries = match std::fs::read_dir(&device_dir) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut files: Vec<(i64, PathBuf, Value)> = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if !path.extension().is_some_and(|e| e == "json") {
            continue;
        }
        let text = std::fs::read_to_string(&path)?; // IO error on an existing file -> Err
        let v: Value = serde_json::from_str(&text).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData,
                format!("corrupt snapshot generation {}: {e}", path.display()))
        })?;
        let captured = v.get("capturedAt").and_then(Value::as_i64).unwrap_or(0);
        files.push((captured, path, v));
    }
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    Ok(files)
}

/// The RAW device ids that have at least one persisted generation (read from
/// each device's stored `deviceId`, so the API never leaks the encoded folder
/// name). Sorted + deduped. FAIL-LOUD: a missing root is absence (`Ok(empty)`);
/// an unreadable dir or a corrupt device file is an ERROR (`Err`).
pub fn list_snapshot_devices(dir: &Path) -> std::io::Result<Vec<String>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut ids: Vec<String> = Vec::new();
    for entry in entries {
        let dpath = entry?.path();
        if !dpath.is_dir() {
            continue;
        }
        // First readable *.json in the device dir carries the raw deviceId.
        let first_json = std::fs::read_dir(&dpath)?
            .flatten()
            .map(|f| f.path())
            .find(|p| p.extension().is_some_and(|x| x == "json"));
        if let Some(p) = first_json {
            let text = std::fs::read_to_string(&p)?;
            let v: Value = serde_json::from_str(&text).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidData,
                    format!("corrupt snapshot generation {}: {e}", p.display()))
            })?;
            if let Some(id) = v.get("deviceId").and_then(Value::as_str) {
                ids.push(id.to_string());
            }
        }
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// The Nth-newest single point-in-time FILE across the merged all-clients list
/// (0 = newest single file). A single-client file, NOT a coherent device
/// generation. `Ok(None)` if out of range, `Err` on IO/parse.
pub fn read_generation(dir: &Path, device_id: &str, generation: usize) -> std::io::Result<Option<Value>> {
    Ok(all_generations_parsed(dir, device_id)?.into_iter().nth(generation).map(|(_, _, v)| v))
}

/// The single point-in-time file whose content digest == `generation_id`
/// (stable across file additions/removals, unlike the positional index).
/// `Ok(None)` if no file matches, `Err` on IO/parse.
pub fn read_generation_by_id(dir: &Path, device_id: &str, generation_id: &str) -> std::io::Result<Option<Value>> {
    Ok(all_generations_parsed(dir, device_id)?.into_iter()
        .map(|(_, _, v)| v)
        .find(|v| snapshot_content_id(v) == generation_id))
}

/// Union of a SPECIFIC set of generations addressed by their stable ids — the
/// IMMUTABLE bundle the deploy capture recorded (`:2621`). Restores the SAME
/// coherent MULTI-CLIENT union the operator saw at capture time (the exact set of
/// per-client component generations), never a single client's slice. Runs the
/// SHARED `union_of_newest_per_client` over just the picked files, so a bundle of
/// each client's newest generation reproduces that capture's union exactly.
/// `Ok(None)` when NONE of the ids match; `Err` on IO/parse.
pub fn read_generations_union_by_ids(dir: &Path, device_id: &str, ids: &[String])
    -> std::io::Result<Option<Value>> {
    let want: std::collections::HashSet<String> = ids.iter().cloned().collect();
    let picked: Vec<(i64, PathBuf, Value)> = all_generations_parsed(dir, device_id)?
        .into_iter()
        .filter(|(_, _, v)| want.contains(&snapshot_content_id(v)))
        .collect();
    let Some((records, max_captured, max_rev, label_src)) = union_of_newest_per_client(&picked) else {
        return Ok(None);
    };
    Ok(Some(json!({
        "deviceId": label_src.get("deviceId").cloned().unwrap_or(Value::Null),
        "deviceLabel": label_src.get("deviceLabel").cloned().unwrap_or(Value::Null),
        "snapshotRevision": max_rev, "capturedAt": max_captured, "records": records,
    })))
}

/// Newest generation file per client instance, deterministic even at equal
/// capturedAt (higher capturedAt wins; tie broken by the greater path — filename
/// embeds the padded revision). Returns (client -> parsed snapshot).
fn newest_per_client(parsed: &[(i64, PathBuf, Value)]) -> HashMap<String, (i64, PathBuf, Value)> {
    let mut newest: HashMap<String, (i64, PathBuf, Value)> = HashMap::new();
    for (captured, path, v) in parsed {
        let client = v.get("clientInstanceId").and_then(Value::as_str).unwrap_or("").to_string();
        let cand = (*captured, path.clone(), v.clone());
        newest.entry(client)
            .and_modify(|cur| if (cand.0, &cand.1) > (cur.0, &cur.1) { *cur = cand.clone(); })
            .or_insert(cand);
    }
    newest
}

/// THE ONE shared union routine (used by BOTH `read_device_union` and
/// `read_device_overview`, so they can never disagree — fixes the divergent
/// tie-break defect `:570`). Union of each client's NEWEST generation's records,
/// deduped by `tabKey` keeping the highest `(revision, updatedAt)`; when BOTH are
/// equal, the tie-break is the SOURCE generation's `(clientInstanceId,
/// generationId)` — components that ACTUALLY differ per candidate (the tab key
/// does NOT, so it can never break a tie). Returns
/// `(records, max_capturedAt, max_snapshotRevision, label_source)` or `None` when
/// the device has no generations. `deviceId`/`deviceLabel` come from the client
/// whose newest generation has the max `(capturedAt, generationId)` — never from
/// arbitrary iteration order.
fn union_of_newest_per_client(parsed: &[(i64, PathBuf, Value)]) -> Option<(Vec<Value>, i64, i64, Value)> {
    let newest = newest_per_client(parsed);
    if newest.is_empty() {
        return None;
    }
    let label_src = newest.values()
        .max_by(|a, b| (a.0, snapshot_content_id(&a.2)).cmp(&(b.0, snapshot_content_id(&b.2))))
        .map(|(_, _, v)| v.clone())
        .unwrap_or(Value::Null);
    // tabKey -> (winning record, its rank tuple).
    let mut by_key: HashMap<String, (Value, (i64, i64, String, String))> = HashMap::new();
    let (mut max_captured, mut max_rev) = (0i64, 0i64);
    for (_, _, snap) in newest.values() {
        max_captured = max_captured.max(snap.get("capturedAt").and_then(Value::as_i64).unwrap_or(0));
        max_rev = max_rev.max(snap.get("snapshotRevision").and_then(Value::as_i64).unwrap_or(0));
        // Per-source tie-break components (constant within a generation).
        let src_client = snap.get("clientInstanceId").and_then(Value::as_str).unwrap_or("").to_string();
        let src_gen = snapshot_content_id(snap);
        for rec in snap.get("records").and_then(Value::as_array).cloned().unwrap_or_default() {
            let key = rec.get("tabKey").and_then(Value::as_str).unwrap_or("").to_string();
            let rev = rec.get("revision").and_then(Value::as_i64).unwrap_or(0);
            let upd = rec.get("updatedAt").and_then(Value::as_i64).unwrap_or(0);
            let rank = (rev, upd, src_client.clone(), src_gen.clone());
            let better = by_key.get(&key).map_or(true, |(_, cur)| &rank > cur);
            if better {
                by_key.insert(key, (rec, rank));
            }
        }
    }
    let mut records: Vec<Value> = by_key.into_values().map(|(rec, _)| rec).collect();
    records.sort_by_key(|r| r.get("tabKey").and_then(Value::as_str).unwrap_or("").to_string());
    Some((records, max_captured, max_rev, label_src))
}

/// The COHERENT device recovery snapshot (the shared union above). `Ok(None)`
/// when the device has no generations; `Err` on IO/parse (`:480`).
pub fn read_device_union(dir: &Path, device_id: &str) -> std::io::Result<Option<Value>> {
    let parsed = all_generations_parsed(dir, device_id)?;
    let Some((records, max_captured, max_rev, label_src)) = union_of_newest_per_client(&parsed) else {
        return Ok(None);
    };
    Ok(Some(json!({
        "deviceId": label_src.get("deviceId").cloned().unwrap_or(Value::Null),
        "deviceLabel": label_src.get("deviceLabel").cloned().unwrap_or(Value::Null),
        "snapshotRevision": max_rev,
        "capturedAt": max_captured,
        "records": records,
    })))
}

/// SINGLE-scan device overview: `(union, generations_meta)` newest-first. The
/// list endpoint calls this ONCE per device (no per-index rescan/reparse). The
/// union comes from the SAME `union_of_newest_per_client` as `read_device_union`,
/// so the list view and the restore/read view agree. `Ok(None)` when absent,
/// `Err` on IO/parse (`:480`).
pub fn read_device_overview(dir: &Path, device_id: &str) -> std::io::Result<Option<(Value, Vec<Value>)>> {
    let parsed = all_generations_parsed(dir, device_id)?;
    if parsed.is_empty() {
        return Ok(None);
    }
    let meta: Vec<Value> = parsed.iter().enumerate().map(|(n, (captured, _, v))| json!({
        "generation": n,
        "generationId": snapshot_content_id(v),
        "capturedAt": captured,
        "snapshotRevision": v.get("snapshotRevision").cloned().unwrap_or(Value::Null),
        "deviceLabel": v.get("deviceLabel").cloned().unwrap_or(Value::Null),
        "clientInstanceId": v.get("clientInstanceId").cloned().unwrap_or(Value::Null),
        "recordCount": v.get("records").and_then(Value::as_array).map(|r| r.len()).unwrap_or(0),
    })).collect();
    let (records, max_captured, max_rev, label_src) =
        union_of_newest_per_client(&parsed).unwrap_or((Vec::new(), 0, 0, Value::Null));
    let union = json!({
        "deviceId": label_src.get("deviceId").cloned().unwrap_or(Value::Null),
        "deviceLabel": label_src.get("deviceLabel").cloned().unwrap_or(Value::Null),
        "snapshotRevision": max_rev, "capturedAt": max_captured, "records": records,
    });
    Ok(Some((union, meta)))
}
```

Add the field + constructor on `TabsRegistry` in `tabs.rs` (currently
`#[derive(Clone, Default)]` over just `inner` — keep `Default` by making the dir
an `Option`; add `use std::path::PathBuf;` if not already imported):

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
`Ok(PushAck { ... })` (`tabs.rs:207`), release the lock and persist off-lock via
the free function in the new module:

```rust
        drop(state); // release the registry mutex before filesystem I/O
        if let Some((dir, records)) = persist_input {
            crate::tabs_persist::persist_generation(
                &dir, server_instance_id, device_id, device_label,
                client_instance_id, snapshot_revision, &records, now,
            );
        }
```

(`now`, `server_instance_id`, `device_id`, `device_label`, `client_instance_id`,
`snapshot_revision` are all still in scope — none were moved; only `key` and
`open_records`/`closed_records` were.)

Back in `tabs_persist.rs`, the persistence writer is a FREE function (all args
explicit, incl. `captured_at`, so tests inject deterministic timestamps):

```rust
/// Process-wide serialization of ALL snapshot-directory mutation (write, prune,
/// device-file eviction, device-dir `remove_dir_all`). Held across the ENTIRE
/// read-plan-mutate cycle, so concurrent pushes to the SAME or DIFFERENT devices
/// can never race directory enumeration, eviction, or removal — the critical
/// data-loss defect (`:678`). `Mutex::new(())` is `const`, so this needs no
/// lazy init. Restores/pushes are low-frequency and this lock guards only the
/// filesystem cycle (in-memory registry work already dropped its own lock), so
/// contention is negligible and there is no nested acquisition to deadlock on.
static PERSIST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Remove any orphaned `.tmp` files a crashed write left behind in this device
/// dir. They are hidden dotfiles excluded from the `*.json` cap math, so an
/// un-reaped `.tmp` would silently consume disk OUTSIDE every cap and falsify the
/// hard 2.5 GiB bound. Reaped under `PERSIST_LOCK` (no other writer owns an
/// in-flight `.tmp` concurrently), BEFORE cap accounting, so caps see the true
/// on-disk footprint. Reap failures are LOGGED (never ignored).
fn sweep_orphan_tmp(device_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(device_dir) else { return; };
    for path in entries.flatten().map(|e| e.path()) {
        if path.extension().is_some_and(|e| e == "tmp") {
            if let Err(err) = std::fs::remove_file(&path) {
                tracing::warn!(target: "freshell_ws::tabs", path = %path.display(),
                    error = %err, "tabs_snapshot_orphan_tmp_reap_failed");
            }
        }
    }
}

/// Write `<root>/<enc(device)>/<enc(client)>-<capturedAt:020>-r<rev:012>.json`
/// atomically (tmp + rename), then enforce every retention cap: oversize skip,
/// per-(device,client) generation cap, global-per-device file cap, device count
/// cap. The ENTIRE read-plan-mutate cycle runs under `PERSIST_LOCK` so it is
/// atomic w.r.t. any other push (`:678`). Best-effort: any failure is a WARN
/// with the full path + error, never an Err (a failed snapshot must never fail a
/// tabs push), and a partial-write failure leaves the last-good generations
/// intact (nothing is deleted before the new file is durably renamed into place).
#[allow(clippy::too_many_arguments)]
pub(crate) fn persist_generation(
    dir: &Path,
    server_instance_id: &str,
    device_id: &str,
    device_label: &str,
    client_instance_id: &str,
    snapshot_revision: i64,
    open_records: &[Value],
    captured_at: i64,
) {
        // Serialize the whole filesystem cycle. Poison-tolerant: a prior panic
        // while persisting must not wedge all future pushes.
        let _guard = PERSIST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
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
            // Reap orphaned `.tmp` BEFORE cap math so it reflects true disk use.
            sweep_orphan_tmp(&device_dir);
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
                remove_file_logged(&client_files.remove(0));
            }
            // GLOBAL-per-device cap: bound total files across ALL clients so a
            // rotating clientInstanceId can't grow the dir without limit. Evict
            // the globally OLDEST files (by capturedAt embedded in the filename,
            // which sorts client-prefix-then-capturedAt) until at/under the cap.
            enforce_device_file_cap(&device_dir)?;
            Ok(())
        };
        if let Err(err) = write() {
            tracing::warn!(target: "freshell_ws::tabs", device_id = %device_id, dir = %dir.display(),
                error = %err, "tabs_snapshot_persist_failed: generation not written");
        }
}
```

Free helpers (module scope). Deletion failures are LOGGED, never silently
dropped, so an eviction that fails is visible instead of quietly breaking the
bound (`:678`):

```rust
/// Remove a file, logging (not swallowing) any failure.
fn remove_file_logged(path: &Path) {
    if let Err(err) = std::fs::remove_file(path) {
        tracing::warn!(target: "freshell_ws::tabs", path = %path.display(),
            error = %err, "tabs_snapshot_evict_file_failed");
    }
}

/// Enforce MAX_SNAPSHOT_FILES_PER_DEVICE across ALL clients in one device dir.
/// Removes the globally OLDEST files (by the capturedAt field embedded in the
/// filename `<client>-<capturedAt:020>-r<rev:012>.json`; `<client>` is escaped
/// and has no `-`, so the 2nd `-`-delimited field is always capturedAt) until
/// at/under the cap. Caller holds `PERSIST_LOCK`; the `.tmp` sweep already ran,
/// so only real `*.json` generations are in view. This is the global-within-
/// device bound that survives client-id rotation.
fn enforce_device_file_cap(device_dir: &Path) -> std::io::Result<()> {
    let mut files: Vec<(String, PathBuf)> = std::fs::read_dir(device_dir)?
        .flatten().map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .filter_map(|p| {
            let name = p.file_name()?.to_str()?;
            let captured = name.splitn(3, '-').nth(1)?.to_string(); // 020-padded -> lexicographic == numeric
            Some((captured, p))
        })
        .collect();
    if files.len() <= MAX_SNAPSHOT_FILES_PER_DEVICE {
        return Ok(());
    }
    files.sort(); // oldest capturedAt (then filename) first
    while files.len() > MAX_SNAPSHOT_FILES_PER_DEVICE {
        let (_, victim) = files.remove(0);
        remove_file_logged(&victim);
    }
    Ok(())
}

/// Enforce MAX_SNAPSHOT_DEVICES. If `target_dir` is NEW and the root is already
/// at the cap, remove the device dir with the OLDEST newest-generation capturedAt.
/// Caller holds `PERSIST_LOCK`, so no writer is populating a victim concurrently.
/// A missing root is absence (`Ok`); any other `read_dir` failure propagates so
/// the caller logs it rather than silently skipping the cap.
fn enforce_device_cap(root: &Path, target_dir: &Path) -> std::io::Result<()> {
    if target_dir.exists() {
        return Ok(());
    }
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
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
        if let Err(err) = std::fs::remove_dir_all(&victim) {
            tracing::warn!(target: "freshell_ws::tabs", path = %victim.display(),
                error = %err, "tabs_snapshot_evict_device_failed");
        }
    }
    Ok(())
}
```

- [x] **Step 3b: Run the WS push persistence OFF the async runtime (`:1480`)**

`persist_generation` does blocking `read_dir`/`write`/`rename`/`remove_*` under
`PERSIST_LOCK`, and `replace_client_snapshot` calls it inline. The WS push
handler `handle_tabs_push` (`terminal.rs:1614-1648`) is `async`, so it must NOT
run that blocking cycle on a Tokio worker. Wrap the whole `replace_client_snapshot`
call in `tokio::task::spawn_blocking` (owning the small `&str` args as `String`s
first; `TabsRegistry` is `Clone`/`Arc`-backed and `records` is already owned):

```rust
    let reg = state.tabs.clone();
    let server_instance_id = state.server_instance_id.as_str().to_string();
    let (device_id, device_label, client_instance_id) =
        (device_id.to_string(), device_label.to_string(), client_instance_id.to_string());
    let joined = tokio::task::spawn_blocking(move || {
        reg.replace_client_snapshot(
            &server_instance_id, &device_id, &device_label,
            &client_instance_id, snapshot_revision, records,
        )
    })
    .await;
    match joined {
        Ok(Ok(ack)) => {
            let msg = ServerMessage::TabsSyncAck(freshell_protocol::TabsSyncAck {
                accepted: ack.accepted,
                open_records: ack.open_records,
                closed_records: ack.closed_records,
            });
            send(ws_tx, &msg).await
        }
        Ok(Err(message)) => send_tabs_error(ws_tx, &message).await,
        Err(join_err) => {
            tracing::warn!(target: "freshell_ws::tabs", error = %join_err,
                "tabs_push_persist_task_panicked");
            send_tabs_error(ws_tx, "tabs snapshot persistence task failed").await
        }
    }
```

The other callers of `replace_client_snapshot` stay synchronous on purpose: the
REST retire beacon (`boot.rs:63-93`) does no persistence (its records are empty /
retire-only, so `persist_generation`'s empty-guard skips it), and the unit tests
call it directly (they WANT the deterministic on-disk write inline). Only the WS
push path — the one that carries real `open_records` — moves to `spawn_blocking`.
**Per-handler `spawn_blocking` checklist (also enforced in Tasks 2-3):** the
snapshot LIST handler, the snapshot FETCH handler, and the RESTORE handler each
wrap their filesystem reads/marker IO in `spawn_blocking`; a reviewer verifies no
`freshell_ws::tabs_persist::*` or `std::fs`/marker call runs directly in an
`async fn` body. Concurrency is naturally bounded: the WS push path is per
connection and persistence is further serialized by `PERSIST_LOCK`.

- [x] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws`
Expected: PASS (all new tests + every pre-existing `tabs.rs` test unchanged).

- [x] **Step 5: Wire the persist dir in `main.rs`**

In `crates/freshell-server/src/main.rs` around line 272-274, replace
`let tabs = freshell_ws::tabs::TabsRegistry::new();` with construction from
the SAME home resolution the settings store uses just above it in `main()`
(main.rs resolves `FRESHELL_HOME`/`HOME` into a home path near line 120 —
reuse that binding; a `None` home keeps the in-memory-only registry):

```rust
    // Tabs registry now persists rolling snapshot generations under
    // `<home>/.freshell/tabs-snapshots/<deviceId>/` (last 5 per (device,
    // client), 40 files per device) so a
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

- [x] **Step 6: Verify build + full crate tests**

Run: `cargo test -p freshell-ws -p freshell-server && cargo build --release -p freshell-server`
Expected: green; release binary rebuilt.
Then run `rust_check`/`cargo fmt --all -- --check` and `cargo clippy -p freshell-ws -p freshell-server` — clean on touched files.

- [x] **Step 7: Commit**

```bash
git add crates/freshell-ws/src/tabs_persist.rs crates/freshell-ws/src/tabs.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/lib.rs crates/freshell-ws/Cargo.toml crates/freshell-server/src/main.rs
git commit -m "feat(tabs-sync): persist rolling per-(device,client) snapshot generations under ~/.freshell

New tabs_persist module (keeps tabs.rs under the 1k-line limit): 5 generations
per (device,client), a global-per-device file cap (40) that holds across client-id
rotation, a device-count cap (64), oversize skip, injective containment-safe id
encoding (escapes '-' so client ownership is unambiguous), atomic writes, and an
empty-push guard so a wipe never overwrites the last-good snapshot. Continuity
trio deliverable 1/3.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 2: Snapshot read REST endpoints

**Files:**
- Create: `crates/freshell-server/src/tabs_snapshots.rs`
- Modify: `crates/freshell-server/src/main.rs` (module decl + router merge)

**Interfaces:**
- Consumes: `freshell_ws::tabs_persist::{list_snapshot_devices, read_device_overview, read_device_union, read_generation, read_generation_by_id}` (Task 1); `crate::boot::is_authed` (`pub(crate)`, `boot.rs:686`).
- Produces:
  - `GET /api/tabs-sync/snapshots` → `{"devices":[{"deviceId":"<raw id>","recordCount":<union count>,"capturedAt":<union max>,"deviceLabel":"...","generations":[{"generation":0,"generationId":"<content digest>","capturedAt":...,"snapshotRevision":...,"recordCount":...,"deviceLabel":"...","clientInstanceId":"..."}]}]}`. `deviceId` is the RAW id (via `list_snapshot_devices`); top-level `recordCount`/`capturedAt` reflect the COHERENT union so the operator sees the true recovery view even with multiple clients; `generations[]` is the merged all-clients point-in-time list (each is a SINGLE-CLIENT file, newest-first). **`generationId` is a STABLE content digest** — the deploy remediation references generations by this id, never by the shifting positional `generation` index. **Performance:** the handler calls `read_device_overview(dir, device)` ONCE per device (a single directory scan producing BOTH the union and the generation list), inside `tokio::task::spawn_blocking` — NOT `read_generation` per index (which the earlier plan re-scanned/re-parsed every file per index: quadratic, an authenticated event-loop DoS). A corrupt file surfaced by any per-device `read_device_overview` propagates as a 500 for the whole list (fail-loud, `:480`), not a silently-dropped device.
  - `GET /api/tabs-sync/snapshots/{deviceId}` (no `generation`/`generationId` param) → the UNION recovery snapshot (`read_device_union`); `?generation=N` → the Nth-newest point-in-time file (`read_generation`); `?generationId=<digest>` → the file with that stable digest (`read_generation_by_id`); **404 for genuine absence, 400 for a malformed/negative/duplicated/conflicting selector (fail-closed — NEVER a silent union fallback, `:1101`), 500 for a present-but-corrupt/unreadable store or a `spawn_blocking` panic (fail-loud with a structured log, `:480`)**. All filesystem reads run inside `spawn_blocking` and the helpers return `io::Result`, so a corrupt backup can never masquerade as "no backup". See the error-taxonomy table under Step 3.
  - `pub struct TabsSnapshotsState { pub auth_token: std::sync::Arc<String>, pub snapshots_dir: Option<std::path::PathBuf>, pub fresh_agent: freshell_freshagent::FreshAgentState, pub screenshots: freshell_ws::screenshot::ScreenshotBroker, pub terminals: freshell_terminal::TerminalRegistry, pub restore_lock: std::sync::Arc<tokio::sync::Mutex<()>>, pub restore_ack_timeout: std::time::Duration }` — `fresh_agent` drives Task 3's restore create pipeline (over the shared broadcast bus); `screenshots` is Task 3's connected-browser gate AND the delivery-ack round-trip; `terminals` is the SAME `TerminalRegistry` (`main.rs:246`) restore uses to reconcile write-ahead marker entries by `is_running(terminalId)`; `restore_lock` serializes concurrent restores (Task 3) so two in-flight requests can't both read an empty marker and duplicate; `restore_ack_timeout` bounds each delivery-ack wait (production ~5s; tests short). Construct all fields now so the router is built once.
  - `pub fn router(state: TabsSnapshotsState) -> axum::Router`

- [x] **Step 1: Write the failing tests**

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

    // A test rig wiring the screenshot broker + the fresh-agent create pipeline to
    // ONE shared broadcast bus (exactly as `main.rs:196,202,232` do), plus the ONE
    // shared TerminalRegistry restore uses for marker reconciliation. `bus` is kept
    // so a test can subscribe an in-process "browser" that answers the delivery-ack
    // screenshot round-trip. Ack timeout is short so the connection-drop test is fast.
    struct Rig {
        state: TabsSnapshotsState,
        bus: std::sync::Arc<tokio::sync::broadcast::Sender<String>>,
        terminals: freshell_terminal::TerminalRegistry,
    }
    fn rig(dir: &std::path::Path) -> Rig {
        let bus = std::sync::Arc::new(tokio::sync::broadcast::channel::<String>(256).0);
        let terminals = freshell_terminal::TerminalRegistry::new();
        let fresh_agent = freshell_freshagent::FreshAgentState::new(
            std::sync::Arc::new(TOKEN.to_string()), bus.clone())
            .with_terminal_registry(terminals.clone());
        let state = TabsSnapshotsState {
            auth_token: std::sync::Arc::new(TOKEN.to_string()),
            snapshots_dir: Some(dir.to_path_buf()),
            fresh_agent,
            screenshots: freshell_ws::screenshot::ScreenshotBroker::new(bus.clone()),
            terminals: terminals.clone(),
            restore_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            restore_ack_timeout: std::time::Duration::from_millis(300),
        };
        Rig { state, bus, terminals }
    }
    // Back-compat helper for the read-endpoint tests (no delivery needed).
    fn test_state(dir: &std::path::Path) -> TabsSnapshotsState { rig(dir).state }

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
        assert!(gens[0]["generationId"].is_string(), "stable content digest exposed");
        assert_ne!(gens[0]["generationId"], gens[1]["generationId"]);
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
        // generationId=<digest of the older file> -> the SAME older file (stable selector)
        let (_, list) = get(router(test_state(dir.path())), "/api/tabs-sync/snapshots", true).await;
        let old_id = list["devices"][0]["generations"][1]["generationId"].as_str().unwrap().to_string();
        let (_, by_id) = get(router(test_state(dir.path())),
            &format!("/api/tabs-sync/snapshots/dev-1?generationId={old_id}"), true).await;
        assert_eq!(by_id["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"], "s-old");
        let (status, _) =
            get(router(test_state(dir.path())), "/api/tabs-sync/snapshots/nope", true).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn fetch_rejects_malformed_selectors_with_400_never_union_fallback() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), "dev-1", "c1", 1, "s-old");
        for bad in [
            "/api/tabs-sync/snapshots/dev-1?generation=-1",       // negative
            "/api/tabs-sync/snapshots/dev-1?generation=abc",      // non-numeric
            "/api/tabs-sync/snapshots/dev-1?generation=1.5",      // non-integer
            "/api/tabs-sync/snapshots/dev-1?generation=1&generation=2", // duplicated
            "/api/tabs-sync/snapshots/dev-1?generation=0&generationId=abc", // conflicting
            "/api/tabs-sync/snapshots/dev-1?generationId=",       // empty id
        ] {
            let (status, _) = get(router(test_state(dir.path())), bad, true).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "must 400 (never silent union): {bad}");
        }
    }

    #[tokio::test]
    async fn corrupt_generation_file_returns_500_not_404() {
        // A PRESENT but unparseable backup is an ERROR (500), never "not found".
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), "dev-1", "c1", 1, "s-old");
        let enc = freshell_ws::tabs_persist::encode_device_id("dev-1").unwrap();
        let file = std::fs::read_dir(dir.path().join(&enc)).unwrap().flatten()
            .map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "json")).unwrap();
        std::fs::write(&file, b"{ corrupt").unwrap();
        let (status, _) = get(router(test_state(dir.path())), "/api/tabs-sync/snapshots/dev-1", true).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        let (status, _) = get(router(test_state(dir.path())), "/api/tabs-sync/snapshots", true).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "list must also 500 on a corrupt store");
    }
}
```

The `FreshAgentState`/`ScreenshotBroker` test constructors above are the REAL
`pub` constructors (verified `terminal_tabs.rs:1394-1402`, `screenshot.rs:67`);
no `new_for_tests` helper is added. `freshell-server` already depends on
`freshell-terminal`, `freshell-ws`, and `tokio` (with the `sync` feature), so
these compile in `freshell-server`'s test target.

- [x] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-server tabs_snapshots`
Historical pre-implementation result: FAIL to compile (`tabs_snapshots` module/`router`/`TabsSnapshotsState` missing). Add `mod tabs_snapshots;` to `main.rs` first so the module participates in the build.

- [x] **Step 3: Implement the read endpoints**

`crates/freshell-server/src/tabs_snapshots.rs`:

```rust
//! Tabs-sync snapshot REST surface (continuity trio,
//! docs/plans/2026-07-22-continuity-safety-trio.md). PURELY ADDITIVE: the legacy
//! server has no on-disk snapshot generations and no snapshot/restore routes, so
//! this diverges from no ported behavior and gets no DEVIATIONS ledger entry.
//! Read endpoints serve the generations `freshell_ws::tabs_persist` persists;
//! POST /api/tabs-sync/restore (Task 3) rebuilds tabs by driving the SAME
//! `POST /api/tabs` create pipeline.

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
    /// The SAME `TerminalRegistry` (`main.rs:246`) the WS handler + `fresh_agent`
    /// use. Restore reconciles write-ahead marker entries against it by
    /// `is_running(terminalId)` so a crash between create and marker-promotion
    /// can't cause a duplicate on retry (Task 3, `:1532`).
    pub terminals: freshell_terminal::TerminalRegistry,
    /// Serializes restores so two concurrent requests can't both read an empty
    /// marker and duplicate tabs (Task 3). One process-wide lock is sufficient —
    /// restores are rare, operator-triggered recovery actions.
    pub restore_lock: Arc<tokio::sync::Mutex<()>>,
    /// Bounds each per-pane delivery-ack round-trip (Task 3, `:1460`). Production
    /// ~5s; tests set it short so the connection-drop path is fast.
    pub restore_ack_timeout: std::time::Duration,
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

/// A backup is PRESENT but unreadable/corrupt, OR a `spawn_blocking` task failed:
/// 500 + structured log with the store path + error (`:480`). NEVER 404 (that is
/// reserved for genuine absence) and never a silent empty success. `err` accepts
/// both `std::io::Error` and `tokio::task::JoinError` (both `Display`).
fn snapshots_read_error(dir: &std::path::Path, err: &dyn std::fmt::Display) -> Response {
    tracing::error!(target: "freshell_server::tabs_snapshots", path = %dir.display(),
        error = %err, "tabs_snapshot_store_unreadable");
    (StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "snapshot store unreadable" }))).into_response()
}

/// The parsed generation selector, or a 400 response. FAIL-CLOSED (`:1101`): an
/// invalid, negative, duplicated, or conflicting selector is a 400, never a
/// silent fall-through to the (broader) coherent union.
enum Selector { Union, Index(usize), Id(String) }

fn parse_selector(params: &[(String, String)]) -> Result<Selector, Response> {
    let gens: Vec<&String> = params.iter().filter(|(k, _)| k == "generation").map(|(_, v)| v).collect();
    let ids: Vec<&String> = params.iter().filter(|(k, _)| k == "generationId").map(|(_, v)| v).collect();
    let bad = |msg: &str| (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response();
    if gens.len() > 1 { return Err(bad("duplicate `generation` selector")); }
    if ids.len() > 1 { return Err(bad("duplicate `generationId` selector")); }
    if !gens.is_empty() && !ids.is_empty() {
        return Err(bad("provide `generation` OR `generationId`, not both"));
    }
    if let Some(v) = gens.first() {
        // usize::from_str rejects negatives, non-numerics, and empty -> 400.
        return v.parse::<usize>().map(Selector::Index)
            .map_err(|_| bad("`generation` must be a non-negative integer"));
    }
    if let Some(v) = ids.first() {
        if v.is_empty() { return Err(bad("`generationId` must be non-empty")); }
        return Ok(Selector::Id((*v).clone()));
    }
    Ok(Selector::Union)
}

async fn list_snapshots(
    State(state): State<TabsSnapshotsState>,
    headers: HeaderMap,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(dir) = state.snapshots_dir.clone() else {
        return Json(json!({ "devices": [] })).into_response();
    };
    let dir_for_log = dir.clone();
    // All filesystem work runs off the async runtime (blocking read_dir/parse).
    let result = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<Value>> {
        let mut out = Vec::new();
        for device in freshell_ws::tabs_persist::list_snapshot_devices(&dir)? {
            // ONE directory scan per device -> (union, generation index).
            let (union, generations) = match freshell_ws::tabs_persist::read_device_overview(&dir, &device)? {
                Some(pair) => pair,
                None => (Value::Null, Vec::new()),
            };
            out.push(json!({
                "deviceId": device,
                "deviceLabel": union.get("deviceLabel").cloned().unwrap_or(Value::Null),
                "recordCount": union.get("records").and_then(Value::as_array).map(|r| r.len()).unwrap_or(0),
                "capturedAt": union.get("capturedAt").cloned().unwrap_or(Value::Null),
                "generations": generations,
            }));
        }
        Ok(out)
    }).await;
    match result {
        Ok(Ok(devices)) => Json(json!({ "devices": devices })).into_response(),
        Ok(Err(err)) => snapshots_read_error(&dir_for_log, &err),
        Err(join_err) => snapshots_read_error(&dir_for_log, &join_err),
    }
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
    let Some(dir) = state.snapshots_dir.clone() else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Snapshot not found" }))).into_response();
    };
    let selector = match parse_selector(&params) { Ok(s) => s, Err(resp) => return resp };
    let dir_for_log = dir.clone();
    // No selector -> coherent device union; generationId -> stable-digest file;
    // generation=N -> Nth-newest point-in-time file. All reads off-runtime, fail-loud.
    let result = tokio::task::spawn_blocking(move || -> std::io::Result<Option<Value>> {
        match selector {
            Selector::Id(id) => freshell_ws::tabs_persist::read_generation_by_id(&dir, &device_id, &id),
            Selector::Index(n) => freshell_ws::tabs_persist::read_generation(&dir, &device_id, n),
            Selector::Union => freshell_ws::tabs_persist::read_device_union(&dir, &device_id),
        }
    }).await;
    match result {
        Ok(Ok(Some(snap))) => Json(snap).into_response(),
        Ok(Ok(None)) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Snapshot not found" }))).into_response(),
        Ok(Err(err)) => snapshots_read_error(&dir_for_log, &err),
        Err(join_err) => snapshots_read_error(&dir_for_log, &join_err),
    }
}
```

**Error taxonomy (both read endpoints):**

| Condition | Status | Body / log |
|---|---|---|
| Missing/blank auth token | 401 | `{"error":"Unauthorized"}` |
| No snapshots dir configured (no `home`) | list → 200 `{"devices":[]}`; fetch → 404 | — |
| Genuine absence (no device dir / index out of range / no id match) | 404 | `{"error":"Snapshot not found"}` |
| Malformed/negative/duplicated/conflicting selector | 400 | `{"error":"<reason>"}` (no fs read attempted) |
| Present-but-corrupt file, unreadable dir, or `spawn_blocking` panic | 500 | `{"error":"snapshot store unreadable"}` + `ERROR tabs_snapshot_store_unreadable` with `path`+`error` |

**Auth note:** `is_authed` is `pub(crate)` in `boot.rs:686` — `use crate::boot::is_authed;` (same crate). If not reachable, raise its visibility to `pub(crate)`; do NOT copy the function.

- [x] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server tabs_snapshots`
Expected: PASS.

- [x] **Step 5: Merge the router in `main.rs`**

In the `.merge(...)` chain (`main.rs:620-663`), after `boot::router(...)`:

```rust
        .merge(tabs_snapshots::router(tabs_snapshots::TabsSnapshotsState {
            auth_token: Arc::clone(&auth_token),
            snapshots_dir: home.as_ref().map(|h| h.join(".freshell").join("tabs-snapshots")),
            fresh_agent: fresh_agent_state.clone(),
            screenshots: screenshots.clone(),
            terminals: registry.clone(), // the SAME TerminalRegistry from main.rs:246
            restore_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            restore_ack_timeout: std::time::Duration::from_secs(5),
        }))
```

(Adapt `auth_token`/`home`/`fresh_agent_state`/`screenshots`/`registry` to the
exact local bindings `main.rs` already passes to neighboring routers —
`fresh_agent_state` is used at `main.rs:621`, `screenshots` is the
`ScreenshotBroker` from `main.rs:202`, `registry` is the `TerminalRegistry` from
`main.rs:246` (already cloned into `fresh_agent_state` at `main.rs:251`). Must be
merged AFTER those bindings exist. The `snapshots_dir` here MUST match the
`tabs-snapshots` dir Task 1 wired into the `TabsRegistry`.)

- [x] **Step 6: Full check + commit**

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
- Consumes: `freshell_freshagent::terminal_tabs::create_terminal_or_content_tab_deferred(...)`, which runs the same identity-stamping create pipeline but returns the typed `ui.command` without broadcasting it. Also consumes the snapshot readers/identities, `ScreenshotBroker::{client_snapshot,send_to_client,register_for_client,send_capture_to,resolve_from}`, live terminal reconciliation, the restore lock, and the acknowledgement timeout.
- **Target identity:** under the restore lock the handler selects one connection id. It sends both the deferred `tab.create` and the subsequent `screenshot.capture` through that connection's direct sink. The pending acknowledgement records the same expected id, so a result from a connection that arrived during the restore cannot satisfy it. No client protocol change is required.
- Produces: `POST /api/tabs-sync/restore`, body `{"deviceId":"...", "components":<[string]?>, "generation":<usize?>, "generationId":<string?>, "dryRun":<bool?>, "force":<bool?>}` (`components` = an immutable set of stable generation ids restored as ONE coherent multi-client union — the deploy bundle, `:2621`) →
  - `400` when `deviceId` missing/empty.
  - **`409` target gate — requires EXACTLY ONE capable client** (not `dryRun`, not `force`): `{"error":"restore requires exactly one connected browser (found N); ...","connectedClients":N}` when there is no exclusive connection id. `force:true` overrides the gate but never fans out; `dryRun` bypasses delivery while still reading the marker and classifying already-restored, reconciled-live, in-progress-unconfirmed, and corrupt-marker outcomes.
  - `404` when no such snapshot for `deviceId`.
  - `200 {"deviceId","generation","generationId","sourceId","sourceCapturedAt","broadcastScope":"target-client"|"none","connectedClients":N,"deliveryConfirmed":<bool>,"restored":[...],"skipped":[...],"failed":[...]}`. `deliveryConfirmed` is true only when every delivered pane was acknowledged by the selected browser (or the request was a dry run).
  - `500` ONLY when a marker write fails (see below) — the request must NOT silently report success after failing to record what it restored.
- Snapshot source (priority): `components=[ids]` → `read_generations_union_by_ids` (the immutable multi-client bundle, `:2621`); else `generationId=<digest>` → `read_generation_by_id` (stable point-in-time); else `generation=N` → `read_generation` (positional point-in-time); else `read_device_union` (coherent, all-clients default). `sourceCapturedAt` echoes the chosen snapshot's `capturedAt`; **`sourceId = snapshot_content_id(&snap)`** is the STABLE content identity of whatever snapshot was chosen — the marker keys off THIS, never a positional index. All snapshot reads + marker IO run inside `spawn_blocking` (`:1480`).
- Concurrency: the handler takes `let _guard = state.restore_lock.lock().await;` for the whole read-marker → create → ack → write-marker critical section, so two concurrent restores of the same device can't both see an empty marker.
- Restore semantics (documented in the module doc AND the response envelope):
  - Every OPEN record's pane becomes ONE new tab via a `POST /api/tabs`-equivalent body driven through `create_terminal_or_content_tab` (multi-pane tabs flatten to one tab per pane — the layout tree is client-owned, not restorable server-side). Each pane has a STABLE, deterministic idempotency key `paneKey = "{tabKey}#{paneId}"` (content-derived, NOT a positional index); combined with the per-device marker's `sourceId` (= the generation's `generationId`) the effective server-side create identity is `(deviceId, generationId, paneKey)`.
  - **Identity-loss guard (STRICT preflight, BEFORE spawning):** for `kind:"terminal"`, the snapshot pane's `payload.sessionRef` is validated as follows. (a) ABSENT `sessionRef` key → no identity to lose, restored as-is. (b) PRESENT but not an object, or an object missing a nonempty string `sessionId`, or whose `provider != payload.mode` → the pane is `failed` with `reason:"session-identity-mismatch"` and is NOT spawned. A malformed/partial `sessionRef` is therefore a REPORTED failure, never silently treated as absent. Because the pipeline's `accepted_session_ref_for_mode` acceptance is deterministic, a pane that PASSES preflight is guaranteed to spawn WITH its captured session.
  - **Result verification (not HTTP-200-trust):** the create response envelope is unwrapped — a pane advances toward `restored` only when the create returned success AND `resp_body["status"] == "ok"`; ids are read from `resp_body["data"]` (`{tabId, paneId?, terminalId?}`); any non-ok create is `failed` with the HTTP `status` + `error` body.
  - **Verified delivery (`:1460`), per pane:** after a supported pane's create succeeds, the handler runs a delivery-ack round-trip to the single target client — `let rx = state.screenshots.register(request_id); state.screenshots.send_capture(&request_id, "view", None, None); tokio::time::timeout(state.restore_ack_timeout, rx).await`. ANY resolve (ok OR error) confirms delivery (a reply proves receipt of the earlier in-order `tab.create`); on timeout the handler `cancel`s the request and treats the client as DROPPED. A DROP marks THIS pane `failed{reason:"delivery-unconfirmed"}` and every REMAINING supported pane `failed{reason:"connection-dropped"}` (no further creates are issued); their write-ahead entries stay `in-progress` for reconciliation. `force` with zero capable clients has no ack target: those panes are recorded `restored` but the envelope sets `deliveryConfirmed:false` and their marker state is left `created` (never delivery-confirmed).
  - **Write-ahead marker + reconciliation (`:1532`), atomic + fail-loud:** a real (non-dryRun) restore reads/writes a per-device marker `<device_dir>/last-restore.marker` = `{sourceId, at, panes:{"<paneKey>":{state, terminalId?, at}}}`, keyed by `sourceId` (a marker with a different `sourceId` is stale → empty). `state` is `in-progress` (WRITE-AHEAD: recorded BEFORE the create, promoted to hold the returned `terminalId` after the create returns, still un-acked) or `restored` (delivery-acked). Every marker write is ATOMIC (tmp + rename); the `.marker` extension is invisible to `list_generations`/prune (`*.json` only). Flow per supported, not-already-restored pane: (1) write `in-progress`; (2) create → on success record `terminalId` (still `in-progress`); (3) delivery-ack → on confirm promote to `restored`. On a rerun WITHOUT `force`: a `restored` paneKey is `skipped{reason:"already-restored"}` and NOT recreated; an `in-progress` paneKey is RECONCILED against the live registry — if its recorded `terminalId` is present AND `state.terminals.is_running(terminalId)`, the create side-effect already happened, so it is NOT recreated (re-attempt only the delivery-ack; report `skipped{reason:"reconciled-live"}` when still unconfirmed, or promote to `restored` on ack) — else (no id, or a dead terminal) it is RETRIED. This closes the crash-between-create-and-marker window: a retry never duplicates a still-live terminal and never abandons a dead one. **If any marker write fails the handler returns `500` `{"error":"...","markerError":true, ...the restore body...}`.**
  - **`force` preserves history (`:1497`):** `force` STILL LOADS the prior marker for `sourceId` and unions its entries into the marker it writes; `force` ONLY bypasses the already-restored SKIP (so a `restored` pane is re-created + re-acked) and the target gate — it NEVER discards prior records. The persisted marker is therefore `prior_panes` ∪ `this-run's updates`, so a forced partial-failure can never make a subsequent ordinary restore re-create (duplicate) a pane that an earlier run already restored.
  - `kind:"terminal"` create body → `{"mode": payload.mode || "shell", "cwd": payload.initialCwd (when a string), "name": tabName, "sessionRef": payload.sessionRef (when a valid object per the preflight)}`.
  - `kind:"browser"` → `{"browser": payload.url, "name": tabName}`; `kind:"editor"` → `{"editor": payload.filePath, "name": tabName}`.
  - `kind:"fresh-agent"` and any other kind → `skipped` with `reason:"unsupported-kind"` (the REST create pipeline has no resume shape for agent chat panes — `create_tab` only accepts `agent:"opencode"` fresh creates, `lib.rs:1158-1171`). REPORTED loudly, never silent.

- [x] **Step 1: Write the failing tests**

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

    use std::sync::atomic::{AtomicBool, Ordering};

    // The in-process "browser": subscribes to the SAME broadcast bus the restore
    // broadcasts on and answers every `screenshot.capture` (the delivery ack) while
    // `on` is true. This is a REAL WS receiver (not a counter): a resolved reply is
    // exactly what proves the client received the earlier in-order `tab.create`.
    // Subscribing synchronously before returning means frames are buffered, so the
    // task can never miss the first capture.
    fn spawn_browser(r: &Rig, on: std::sync::Arc<AtomicBool>) -> tokio::task::JoinHandle<()> {
        r.state.screenshots.add_capable_client();
        let mut rx = r.bus.subscribe();
        let broker = r.state.screenshots.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(frame) => {
                        if !on.load(Ordering::SeqCst) { continue; } // silent -> ack times out
                        let v: Value = match serde_json::from_str(&frame) { Ok(v) => v, Err(_) => continue };
                        if v["type"] == "ui.command" && v["command"] == "screenshot.capture" {
                            if let Some(rid) = v["payload"]["requestId"].as_str() {
                                broker.resolve(rid, freshell_ws::screenshot::ScreenshotResult {
                                    ok: true, ..Default::default() });
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break, // sender dropped
                }
            }
        })
    }
    // A rig with exactly one connected, RESPONSIVE browser.
    fn connected(dir: &std::path::Path) -> (Rig, std::sync::Arc<AtomicBool>, tokio::task::JoinHandle<()>) {
        let r = rig(dir);
        let on = std::sync::Arc::new(AtomicBool::new(true));
        let h = spawn_browser(&r, on.clone());
        (r, on, h)
    }
    fn marker_json(dir: &std::path::Path, device: &str) -> Value {
        let enc = freshell_ws::tabs_persist::encode_device_id(device).unwrap();
        serde_json::from_slice(&std::fs::read(dir.join(enc).join(RESTORE_MARKER)).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn restore_rebuilds_supported_panes_and_reports_skips() {
        let dir = tempfile::tempdir().unwrap();
        seed_records(dir.path(), "dev-1", "c1", 3, mixed_records());
        let (r, _on, _h) = connected(dir.path());
        let (status, body) = post(router(r.state.clone()), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["broadcastScope"], "target-client");
        assert_eq!(body["deliveryConfirmed"], true, "single responsive browser acked every tab.create");
        assert!(body["sourceId"].is_string());
        let restored = body["restored"].as_array().unwrap();
        assert_eq!(restored.len(), 2, "shell terminal + browser restored: {body}");
        assert!(restored.iter().any(|r| r["kind"] == "terminal" && r["terminalId"].is_string()));
        assert!(restored.iter().any(|r| r["kind"] == "browser" && r["tabId"].is_string()));
        let skipped = body["skipped"].as_array().unwrap();
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0]["reason"], "unsupported-kind");
        assert_eq!(body["failed"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn restore_rejects_mismatched_or_malformed_session_ref_before_spawning() {
        let dir = tempfile::tempdir().unwrap();
        // (a) codex mode + CLAUDE sessionRef; (b) codex mode + sessionRef object
        // MISSING sessionId -> both must FAIL (never silently spawn fresh).
        seed_records(dir.path(), "dev-1", "c1", 1, vec![
            rec("t1", "terminal", json!({ "mode": "codex",
                "sessionRef": { "provider": "claude", "sessionId": "z" } })),
            rec("t2", "terminal", json!({ "mode": "codex",
                "sessionRef": { "provider": "codex" } }))]); // no sessionId
        let (r, _on, _h) = connected(dir.path());
        let (status, body) = post(router(r.state.clone()), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["restored"].as_array().unwrap().len(), 0);
        let failed = body["failed"].as_array().unwrap();
        assert_eq!(failed.len(), 2);
        assert!(failed.iter().all(|f| f["reason"] == "session-identity-mismatch"));
    }

    #[tokio::test]
    async fn restore_is_idempotent_and_force_bypasses_skip() {
        let dir = tempfile::tempdir().unwrap();
        seed_records(dir.path(), "dev-1", "c1", 1, vec![
            rec("t1", "terminal", json!({ "mode": "shell" }))]);
        // Run 1: restore (marker persisted on disk).
        let (r1, _on1, _h1) = connected(dir.path());
        let first = post(router(r1.state.clone()), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true).await.1;
        assert_eq!(first["restored"].as_array().unwrap().len(), 1);
        // Run 2: a DIFFERENT server instance (fresh TerminalRegistry, SAME on-disk
        // marker dir). The restored terminal isn't in THIS registry, so live-reconcile
        // can't fire -> the pane is skipped `already-restored` (idempotent), nothing
        // recreated. Deterministic (no reliance on kill-exit timing).
        let (r2, _on2, _h2) = connected(dir.path());
        let second = post(router(r2.state.clone()), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true).await.1;
        assert_eq!(second["restored"].as_array().unwrap().len(), 0);
        assert_eq!(second["skipped"][0]["reason"], "already-restored");
        // force bypasses the skip -> re-creates (the terminal is not live in r2).
        let forced = post(router(r2.state.clone()), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1", "force": true }), true).await.1;
        assert_eq!(forced["restored"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn restore_refuses_unless_exactly_one_browser_connected() {
        let dir = tempfile::tempdir().unwrap();
        seed_records(dir.path(), "dev-1", "c1", 1, vec![
            rec("t1", "terminal", json!({ "mode": "shell" }))]);
        // ZERO clients -> 409.
        let (status, body) = post(router(test_state(dir.path())), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true).await;
        assert_eq!(status, StatusCode::CONFLICT, "zero clients must be refused");
        assert_eq!(body["connectedClients"], 0);
        // TWO clients -> 409 (would duplicate onto the bystander).
        let two = rig(dir.path());
        let on2 = std::sync::Arc::new(AtomicBool::new(true));
        let _h2 = spawn_browser(&two, on2);        // count -> 1 (responsive)
        two.state.screenshots.add_capable_client(); // count -> 2
        let (status, body) = post(router(two.state.clone()), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["connectedClients"], 2);
        // force overrides the gate even at 2 (the responsive browser still acks).
        let (status, _) = post(router(two.state.clone()), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1", "force": true }), true).await;
        assert_eq!(status, StatusCode::OK);
        // EXACTLY ONE -> OK.
        let (r, _on, _h) = connected(dir.path());
        let (status, _) = post(router(r.state.clone()), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn restore_dry_run_creates_nothing_and_404_on_missing_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        seed_records(dir.path(), "dev-1", "c1", 3, mixed_records());
        // dryRun is allowed regardless of client count (creates nothing).
        let (status, body) = post(router(test_state(dir.path())), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1", "dryRun": true }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deliveryConfirmed"], true, "dryRun is trivially confirmed");
        assert_eq!(body["restored"].as_array().unwrap().len(), 2);
        assert!(body["restored"][0]["tabId"].is_null());
        // dryRun writes no marker.
        assert!(!dir.path().join(freshell_ws::tabs_persist::encode_device_id("dev-1").unwrap())
            .join(RESTORE_MARKER).exists());
        // Missing snapshot -> 404 even under dryRun (gate bypassed, lookup fails).
        let (status, _) = post(router(test_state(dir.path())), "/api/tabs-sync/restore",
            json!({ "deviceId": "ghost", "dryRun": true }), true).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn delivery_drop_fails_remaining_panes_and_writes_in_progress_marker() {
        // VERIFIED DELIVERY (:1460): one connected but UNRESPONSIVE browser. The
        // first pane's create succeeds but its delivery ack times out -> that pane
        // AND every remaining pane are FAILED (not restored), deliveryConfirmed is
        // false, and the created terminal is recorded IN-PROGRESS (with its id) for
        // reconciliation -- NOT restored.
        let dir = tempfile::tempdir().unwrap();
        seed_records(dir.path(), "dev-1", "c1", 1, vec![
            rec("t1", "terminal", json!({ "mode": "shell" })),
            rec("t2", "terminal", json!({ "mode": "shell" }))]);
        let r = rig(dir.path());
        let off = std::sync::Arc::new(AtomicBool::new(false)); // never answers
        let _h = spawn_browser(&r, off);                        // count 1, unresponsive
        let body = post(router(r.state.clone()), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true).await.1;
        assert_eq!(body["restored"].as_array().unwrap().len(), 0);
        assert_eq!(body["deliveryConfirmed"], false);
        let failed = body["failed"].as_array().unwrap();
        assert!(failed.iter().any(|f| f["reason"] == "delivery-unconfirmed"));
        assert!(failed.iter().any(|f| f["reason"] == "connection-dropped"),
            "the pane after the drop must be FAILED, never restored");
        // The created terminal is recorded IN-PROGRESS in the marker.
        let m = marker_json(dir.path(), "dev-1");
        let states: Vec<&str> = m["panes"].as_object().unwrap().values()
            .filter_map(|p| p["state"].as_str()).collect();
        assert!(states.iter().all(|s| *s == "in-progress"), "nothing marked restored: {m}");
    }

    #[tokio::test]
    async fn write_ahead_reconciles_live_terminal_no_duplicate_on_retry() {
        // MARKER-BEFORE-SIDE-EFFECTS (:1532): run 1 drops delivery after creating
        // the terminal (write-ahead in-progress). Run 2 (now responsive) must
        // RECONCILE that still-live terminal -- promote to restored WITHOUT creating
        // a duplicate. The same terminalId proves no second create happened.
        let dir = tempfile::tempdir().unwrap();
        seed_records(dir.path(), "dev-1", "c1", 1, vec![
            rec("t1", "terminal", json!({ "mode": "shell" }))]);
        let r = rig(dir.path());
        let on = std::sync::Arc::new(AtomicBool::new(false));
        let _h = spawn_browser(&r, on.clone());
        let first = post(router(r.state.clone()), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true).await.1;
        let tid = first["failed"][0]["terminalId"].as_str().unwrap().to_string();
        assert!(r.terminals.is_running(&tid), "terminal created despite delivery drop");
        on.store(true, Ordering::SeqCst); // browser comes back
        let second = post(router(r.state.clone()), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true).await.1;
        let rec0 = &second["restored"][0];
        assert_eq!(rec0["reconciled"], true, "in-progress live pane reconciled, not recreated");
        assert_eq!(rec0["terminalId"], tid, "SAME terminal -> no duplicate create");
        assert_eq!(second["failed"].as_array().unwrap().len(), 0);
        assert_eq!(marker_json(dir.path(), "dev-1")["panes"][pane_key("dev-1:t1", "p-t1").as_str()]["state"], "restored");
    }

    #[tokio::test]
    async fn force_preserves_prior_marker_and_never_duplicates_live_terminal() {
        // FORCE PRESERVES HISTORY (:1497): a normal restore records t1 restored.
        // A subsequent FORCE restore must LOAD + preserve that record and must NOT
        // duplicate the still-live terminal (reconciled), so a later ordinary
        // restore still sees t1 restored (no re-create).
        let dir = tempfile::tempdir().unwrap();
        seed_records(dir.path(), "dev-1", "c1", 1, vec![
            rec("t1", "terminal", json!({ "mode": "shell" }))]);
        let (r, _on, _h) = connected(dir.path());
        let first = post(router(r.state.clone()), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true).await.1;
        let tid = first["restored"][0]["terminalId"].as_str().unwrap().to_string();
        let forced = post(router(r.state.clone()), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1", "force": true }), true).await.1;
        assert_eq!(forced["restored"][0]["reconciled"], true, "force must not recreate a live terminal");
        assert_eq!(forced["restored"][0]["terminalId"], tid, "no duplicate under force");
        // The marker STILL records t1 restored -- force did not discard prior history.
        assert_eq!(marker_json(dir.path(), "dev-1")["panes"][pane_key("dev-1:t1", "p-t1").as_str()]["state"], "restored");
    }
```

(`ScreenshotBroker::{add_capable_client, resolve}` are `pub`, `screenshot.rs:78,119`;
the broker + registry are `Clone`/`Arc`-backed so the in-process browser task and
the handler share the same `Arc<Inner>`. `TerminalRegistry::{is_running, kill}` are
`pub`, `registry.rs:1099,813`.)

- [x] **Step 2: Historical red-test checkpoint (already completed)**

Historical result before the route existed: `cargo test -p freshell-server
tabs_snapshots` failed because the handler/router were missing. At the current
HEAD the route is implemented, so do not attempt to reproduce this obsolete
failure; run the same command expecting PASS as part of current verification.

- [x] **Step 3: Implement restore**

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

Shipped implementation source of truth:

- `crates/freshell-server/src/tabs_snapshots.rs`
- `crates/freshell-server/src/tabs_snapshots_marker.rs`
- `crates/freshell-server/src/tabs_snapshots_selectors.rs`
- `crates/freshell-server/src/tabs_snapshots_tests.rs`
- `crates/freshell-server/src/tabs_snapshots_restore_tests.rs`

The shipped handler uses exact connection-bound delivery and acknowledgement,
strict boolean parsing, marker-aware dry runs, a bounded and semantically
validated marker ledger, durable writes, immutable full-generation identities,
and exact component resolution. Do not reconstruct it from an inline sketch.

<details>
<summary>Archived pre-implementation sketch — non-executable; do not copy</summary>

```text
const RESTORE_MARKER: &str = "last-restore.marker"; // .marker ext -> invisible to *.json listing

/// Map one snapshot pane to its `POST /api/tabs` body, or Err(reason). A terminal
/// pane whose `sessionRef` is present-but-invalid (not an object, missing a
/// nonempty `sessionId`, or `provider != mode`) is rejected HERE (reason
/// `"session-identity-mismatch"`) so the create pipeline can never mint a fresh
/// identity-less session and call it restored. `"unsupported-kind"` is a SKIP;
/// every other Err is a FAIL (classified by the caller).
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
            // STRICT identity preflight: a NULL/absent sessionRef is fine (no
            // identity to lose); a PRESENT one must be an object with a nonempty
            // sessionId AND provider == mode, else the pane FAILS (never spawns
            // fresh under a "restored" label).
            if let Some(sref) = payload.get("sessionRef").filter(|v| !v.is_null()) {
                let ok = sref.is_object()
                    && sref.get("provider").and_then(Value::as_str) == Some(mode)
                    && sref.get("sessionId").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
                if !ok {
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

/// Stable per-pane identity key (content-derived, NOT a positional index).
fn pane_key(tab_key: &str, pane_id: &str) -> String { format!("{tab_key}#{pane_id}") }

/// One pane's marker state (`in-progress` = write-ahead, side-effect may exist,
/// delivery NOT yet confirmed; `restored` = delivery-acked). `terminal_id` is
/// recorded once the create returns, for crash reconciliation.
#[derive(Clone)]
struct PaneMark { state: String, terminal_id: Option<String> }
type Marker = std::collections::HashMap<String, PaneMark>;

/// Read the marker's pane map for `source_id`. A marker whose `sourceId` differs
/// is stale -> empty. (Blocking fs — call via `spawn_blocking`.)
fn read_marker(device_dir: &std::path::Path, source_id: &str) -> Marker {
    let Ok(text) = std::fs::read_to_string(device_dir.join(RESTORE_MARKER)) else { return Marker::new(); };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return Marker::new(); };
    if v.get("sourceId").and_then(Value::as_str) != Some(source_id) {
        return Marker::new();
    }
    let mut out = Marker::new();
    if let Some(map) = v.get("panes").and_then(Value::as_object) {
        for (k, pm) in map {
            out.insert(k.clone(), PaneMark {
                state: pm.get("state").and_then(Value::as_str).unwrap_or("in-progress").to_string(),
                terminal_id: pm.get("terminalId").and_then(Value::as_str).map(str::to_string),
            });
        }
    }
    out
}

/// Atomic (tmp + rename) marker write. Returns Err so the handler fails LOUDLY.
/// (Blocking fs — call via `spawn_blocking`.)
fn write_marker(device_dir: &std::path::Path, source_id: &str, panes: &Marker, at: i64) -> std::io::Result<()> {
    std::fs::create_dir_all(device_dir)?;
    let panes_json: serde_json::Map<String, Value> = panes.iter().map(|(k, pm)| {
        (k.clone(), json!({ "state": pm.state, "terminalId": pm.terminal_id, "at": at }))
    }).collect();
    let bytes = serde_json::to_vec_pretty(&json!({
        "sourceId": source_id, "at": at, "panes": Value::Object(panes_json)
    })).unwrap_or_default();
    let tmp = device_dir.join(format!(".{RESTORE_MARKER}.tmp"));
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, device_dir.join(RESTORE_MARKER))
}

async fn read_marker_async(device_dir: &std::path::Path, source_id: &str) -> Marker {
    let (dd, sid) = (device_dir.to_path_buf(), source_id.to_string());
    tokio::task::spawn_blocking(move || read_marker(&dd, &sid)).await.unwrap_or_default()
}
async fn write_marker_async(device_dir: &std::path::Path, source_id: &str, panes: Marker, at: i64)
    -> std::io::Result<()> {
    let (dd, sid) = (device_dir.to_path_buf(), source_id.to_string());
    match tokio::task::spawn_blocking(move || write_marker(&dd, &sid, &panes, at)).await {
        Ok(r) => r,
        Err(join) => Err(std::io::Error::new(std::io::ErrorKind::Other, join.to_string())),
    }
}

/// Delivery ack: broadcast a `screenshot.capture` to the (single) target client
/// and await ANY reply within `timeout`. A reply proves the client received every
/// earlier in-order frame (incl. this pane's `tab.create`); a timeout means the
/// connection dropped/stalled. Uses a paneKey-derived request id so a stale reply
/// can't cross-resolve. Returns `true` iff delivery was confirmed.
async fn confirm_delivery(state: &TabsSnapshotsState, pane_key: &str) -> bool {
    let request_id = format!("restore-ack:{pane_key}");
    let rx = state.screenshots.register(request_id.clone());
    state.screenshots.send_capture(&request_id, "view", None, None);
    match tokio::time::timeout(state.restore_ack_timeout, rx).await {
        Ok(_) => true,                          // ANY resolve (ok OR error) == received
        Err(_) => { state.screenshots.cancel(&request_id); false }
    }
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
        Some(d) if !d.is_empty() => d.to_string(),
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "deviceId is required" }))).into_response(),
    };
    let dry_run = body.get("dryRun").and_then(Value::as_bool).unwrap_or(false);
    let force = body.get("force").and_then(Value::as_bool).unwrap_or(false);
    let connected = state.screenshots.capable_client_count();

    // Target gate: EXACTLY ONE capable client (reject 0 AND >1). dryRun creates
    // nothing (always allowed); force is an explicit operator override.
    if !dry_run && !force && connected != 1 {
        return (StatusCode::CONFLICT, Json(json!({
            "error": format!("restore requires exactly one connected browser (found {connected}); connect the target device only, or pass force"),
            "connectedClients": connected,
        }))).into_response();
    }

    let Some(dir) = state.snapshots_dir.clone() else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Snapshot not found" }))).into_response();
    };
    // Snapshot selection off the runtime (fail-loud). Errors -> 500. Priority:
    // components (immutable multi-client bundle, :2621) > generationId > generation
    // > coherent union.
    let components: Vec<String> = body.get("components").and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let generation_id_req = body.get("generationId").and_then(Value::as_str).map(str::to_string);
    let generation_n = body.get("generation").and_then(Value::as_u64).map(|g| g as usize);
    let sel = (dir.clone(), device_id.clone(), components.clone(), generation_id_req.clone(), generation_n);
    let read = tokio::task::spawn_blocking(move || -> std::io::Result<Option<Value>> {
        let (dir, device_id, comps, gid, gn) = sel;
        if !comps.is_empty() {
            freshell_ws::tabs_persist::read_generations_union_by_ids(&dir, &device_id, &comps)
        } else if let Some(id) = gid {
            freshell_ws::tabs_persist::read_generation_by_id(&dir, &device_id, &id)
        } else if let Some(g) = gn {
            freshell_ws::tabs_persist::read_generation(&dir, &device_id, g)
        } else {
            freshell_ws::tabs_persist::read_device_union(&dir, &device_id)
        }
    }).await;
    let snap = match read {
        Ok(Ok(Some(snap))) => snap,
        Ok(Ok(None)) => return (StatusCode::NOT_FOUND, Json(json!({ "error": "Snapshot not found" }))).into_response(),
        Ok(Err(err)) => return snapshots_read_error(&dir, &err),
        Err(join) => return snapshots_read_error(&dir, &join),
    };
    // STABLE content identity of the chosen snapshot -> the marker keys off this.
    let source_id = freshell_ws::tabs_persist::snapshot_content_id(&snap);

    // Serialize: hold the lock across read-marker -> create -> ack -> write-marker.
    let _guard = state.restore_lock.lock().await;

    let device_dir = freshell_ws::tabs_persist::encode_device_id(&device_id).map(|e| dir.join(e));
    // ALWAYS load the prior marker (force too, so history is preserved -- :1497);
    // `force` only bypasses the already-restored SKIP below, never the load/union.
    let prior: Marker = match (&device_dir, dry_run) {
        (Some(dd), false) => read_marker_async(dd, &source_id).await,
        _ => Marker::new(),
    };
    let mut marker: Marker = prior.clone(); // the union we will persist

    let mut restored = Vec::new();
    let mut skipped = Vec::new();
    let mut failed = Vec::new();
    let mut delivery_confirmed = true;
    let mut connection_dropped = false; // once true, remaining panes are FAILED
    let records = snap.get("records").and_then(Value::as_array).cloned().unwrap_or_default();
    for record in &records {
        if record.get("status").and_then(Value::as_str) != Some("open") { continue; }
        let tab_key = record.get("tabKey").cloned().unwrap_or(Value::Null);
        let tab_key_str = tab_key.as_str().unwrap_or("").to_string();
        let tab_name = record.get("tabName");
        for pane in record.get("panes").and_then(Value::as_array).cloned().unwrap_or_default().iter() {
            let pane_id = pane.get("paneId").cloned().unwrap_or(Value::Null);
            let pane_id_str = pane_id.as_str().unwrap_or("").to_string();
            let kind = pane.get("kind").cloned().unwrap_or(Value::Null);
            let pk = pane_key(&tab_key_str, &pane_id_str);

            // Preflight/kind classification first (a bad-kind pane never touches
            // the marker or the connection).
            let create_body = match pane_to_create_body(tab_name, pane) {
                Err("unsupported-kind") => { skipped.push(json!({ "tabKey": tab_key, "paneId": pane_id,
                    "kind": kind, "reason": "unsupported-kind" })); continue; }
                Err(reason) => { failed.push(json!({ "tabKey": tab_key, "paneId": pane_id,
                    "kind": kind, "reason": reason })); continue; }
                Ok(b) => b,
            };
            if dry_run {
                restored.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "request": create_body, "tabId": Value::Null }));
                continue;
            }

            let prior_mark = prior.get(&pk).cloned();
            // (1) Live-terminal reconciliation applies ALWAYS (force or not): a
            // prior create whose terminal is STILL RUNNING must NEVER be recreated
            // (that is the duplicate the crash-window and blind force would cause).
            // Re-ack; promote to restored on confirm, else report reconciled-live.
            if let Some(pm) = &prior_mark {
                if pm.terminal_id.as_deref().is_some_and(|t| state.terminals.is_running(t)) {
                    // Re-ack only when a client is present (blind force has no target).
                    let acked = connected >= 1 && !connection_dropped && confirm_delivery(&state, &pk).await;
                    if !acked {
                        delivery_confirmed = false;
                        marker.insert(pk.clone(), pm.clone()); // keep the prior record
                        skipped.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                            "reason": "reconciled-live" }));
                    } else {
                        marker.insert(pk.clone(), PaneMark { state: "restored".into(),
                            terminal_id: pm.terminal_id.clone() });
                        restored.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                            "terminalId": pm.terminal_id, "reconciled": true }));
                    }
                    continue;
                }
            }
            // (2) already-restored SKIP only when !force (force re-creates a
            // restored-but-no-longer-live pane; ordinary is idempotent -- :1497).
            if !force {
                if let Some(pm) = &prior_mark {
                    if pm.state == "restored" {
                        skipped.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                            "reason": "already-restored" }));
                        continue;
                    }
                }
            }

            if connection_dropped {
                failed.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "reason": "connection-dropped" }));
                continue;
            }

            // WRITE-AHEAD: record in-progress BEFORE the side-effect (:1532).
            marker.insert(pk.clone(), PaneMark { state: "in-progress".into(), terminal_id: None });
            if let Some(dd) = &device_dir {
                if let Err(err) = write_marker_async(dd, &source_id, marker.clone(),
                    snap.get("capturedAt").and_then(Value::as_i64).unwrap_or(0)).await {
                    return marker_error(&device_id, &snap, connected, delivery_confirmed,
                        restored, skipped, failed, &err);
                }
            }

            let resp = freshell_freshagent::terminal_tabs::create_terminal_or_content_tab(
                state.fresh_agent.clone(), create_body.clone()).await;
            let status = resp.status();
            let rbytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap_or_default();
            let resp_body: Value = serde_json::from_slice(&rbytes).unwrap_or(Value::Null);
            if !(status.is_success() && resp_body.get("status").and_then(Value::as_str) == Some("ok")) {
                // Create failed -> no NEW side-effect. Restore the PRIOR marker entry
                // (never DISCARD a previously-restored record -- :1497); drop the
                // write-ahead placeholder only when there was no prior entry.
                match &prior_mark {
                    Some(pm) => { marker.insert(pk.clone(), pm.clone()); }
                    None => { marker.remove(&pk); }
                }
                failed.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "status": status.as_u16(), "error": resp_body }));
                continue;
            }
            let data = resp_body.get("data").cloned().unwrap_or(Value::Null);
            let terminal_id = data.get("terminalId").and_then(Value::as_str).map(str::to_string);
            // Record the terminalId (still in-progress until acked) and PERSIST it
            // IMMEDIATELY -- this shrinks the crash-between-create-and-marker window
            // to a single fsync-rename, so a retry reconciles the live terminal by
            // its recorded id instead of duplicating it (:1532).
            marker.insert(pk.clone(), PaneMark { state: "in-progress".into(),
                terminal_id: terminal_id.clone() });
            if let Some(dd) = &device_dir {
                if let Err(err) = write_marker_async(dd, &source_id, marker.clone(),
                    snap.get("capturedAt").and_then(Value::as_i64).unwrap_or(0)).await {
                    return marker_error(&device_id, &snap, connected, delivery_confirmed,
                        restored, skipped, failed, &err);
                }
            }

            // DELIVERY ACK (skip when force has no target to ack).
            let confirmed = if connected >= 1 { confirm_delivery(&state, &pk).await }
                            else { false /* force + 0 clients: blind */ };
            if confirmed {
                marker.insert(pk.clone(), PaneMark { state: "restored".into(), terminal_id: terminal_id.clone() });
                restored.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "tabId": data.get("tabId").cloned().unwrap_or(Value::Null), "terminalId": terminal_id }));
            } else if connected >= 1 {
                // A real client that stopped answering == dropped mid-restore. The
                // terminal WAS created (recorded in-progress with its id for the
                // next run's reconciliation); it is reported failed, NOT restored.
                delivery_confirmed = false;
                connection_dropped = true;
                failed.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "reason": "delivery-unconfirmed", "terminalId": terminal_id }));
            } else {
                // force + 0 clients: created but delivery cannot be confirmed.
                delivery_confirmed = false;
                restored.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "tabId": data.get("tabId").cloned().unwrap_or(Value::Null), "terminalId": terminal_id }));
            }
        }
    }

    if !dry_run {
        if let Some(dd) = &device_dir {
            if let Err(err) = write_marker_async(dd, &source_id, marker.clone(),
                snap.get("capturedAt").and_then(Value::as_i64).unwrap_or(0)).await {
                return marker_error(&device_id, &snap, connected, delivery_confirmed,
                    restored, skipped, failed, &err);
            }
        }
    }

    Json(json!({
        "deviceId": device_id,
        "generation": generation_n,
        "generationId": generation_id_req,
        "sourceId": source_id,
        "sourceCapturedAt": snap.get("capturedAt").cloned().unwrap_or(Value::Null),
        "broadcastScope": "all-connected-clients",
        "connectedClients": connected,
        "deliveryConfirmed": dry_run || delivery_confirmed,
        "restored": restored,
        "skipped": skipped,
        "failed": failed,
    })).into_response()
}

/// A marker write failed AFTER side-effects: 500, fail LOUDLY, echoing what was
/// done so a lost marker can never read as a clean success.
#[allow(clippy::too_many_arguments)]
fn marker_error(device_id: &str, snap: &Value, connected: i64, delivery_confirmed: bool,
    restored: Vec<Value>, skipped: Vec<Value>, failed: Vec<Value>, err: &dyn std::fmt::Display) -> Response {
    tracing::error!(target: "freshell_server::tabs_snapshots", device_id = %device_id,
        error = %err, "restore_marker_write_failed");
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
        "deviceId": device_id,
        "sourceCapturedAt": snap.get("capturedAt").cloned().unwrap_or(Value::Null),
        "connectedClients": connected,
        "deliveryConfirmed": delivery_confirmed,
        "error": format!("restore marker write failed: {err}"),
        "markerError": true,
        "restored": restored, "skipped": skipped, "failed": failed,
    }))).into_response()
}
```

</details>

- [x] **Step 4: Run tests to verify they pass**

Run TWO commands (a single `-p A -p B <filter>` would apply the `tabs_snapshots`
name filter to BOTH crates and run NONE of `freshell-freshagent`'s tests — a
vacuous gate):
```
cargo test -p freshell-server tabs_snapshots   # the new REST tests
cargo test -p freshell-freshagent              # full suite -> proves the pub-visibility change regressed nothing
```
Expected: both PASS.

- [x] **Step 5: Run fmt/clippy on touched crates**

Run: `cargo clippy -p freshell-server -p freshell-freshagent && cargo fmt --all -- --check && cargo build --release -p freshell-server`
Expected: clean.

- [x] **Step 6: Confirm NO DEVIATIONS ledger entry is required**

Do NOT touch `port/oracle/DEVIATIONS.md`. Per its own entry rules (`port/oracle/DEVIATIONS.md:9-16`, re-verified: "An entry may be added ONLY when the original is **objectively defective**"), a ledger entry requires an objective defect in a PORTED behavior. This work is PURELY ADDITIVE — new on-disk snapshot generations and new `/api/tabs-sync/snapshots[/{deviceId}]` + `/api/tabs-sync/restore` routes that do not exist in, and do not change, any ported surface. There is no old-vs-new divergence on any ported route, so there is no `objective_defect` to cite and an `objective_defect: n/a` entry would be rejected by the antagonist reviewer. The additive surface is documented in the module doc comments and this plan; that is the correct home for it. (This reverses the earlier plan's invalid ledger-entry step.)

- [x] **Step 7: Commit**

```bash
git add crates/freshell-server/src/tabs_snapshots.rs crates/freshell-freshagent/src/terminal_tabs.rs
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
- Produces: `scripts/restore-tabs.sh --url <base> --token <tok> --device <deviceId> [--components ID,ID | --generation-id ID | --generation N] [--pane KEY] [--force] [--dry-run]` and `--list`. **Default (no selector) restores the coherent all-clients UNION** — no single client's tabs are dropped. `--components ID,ID` (a comma-separated set of stable generation ids) restores the IMMUTABLE multi-client bundle the deploy capture recorded — this is what the deploy remediation prints (`:2621`), NEVER a single-client `--generation-id`. A targeted invocation succeeds only when at least one pane is restored; forced recovery additionally requires `deliveryConfirmed:true`. Any failed pane, unconfirmed delivery, all-skipped targeted result, or HTTP error exits 1.

- [x] **Step 1: Historical script draft (superseded; do not copy)**

> The embedded block below predates the shipped `--force` passthrough and
> delivery-confirmed/all-skipped success checks. It is retained only as
> historical context. The executable source of truth is
> `scripts/restore-tabs.sh`; never overwrite it from this block.

```bash
#!/usr/bin/env bash
# restore-tabs.sh -- rebuild a device's tabs from its newest (or Nth) tabs-sync
# snapshot generation. Continuity trio deliverable 1
# (docs/plans/2026-07-22-continuity-safety-trio.md).
#
#   scripts/restore-tabs.sh --url http://127.0.0.1:PORT --token TOK --list
#   scripts/restore-tabs.sh --url http://127.0.0.1:PORT --token TOK \
#       --device <deviceId> [--generation N | --generation-id ID] [--dry-run]
#
# DEFAULT (no --generation/--generation-id): restores the COHERENT all-clients
# UNION for the device -- no single client's tabs are dropped. Pass
# --generation-id ID (a stable content digest from --list) to restore a specific
# past point-in-time file; --generation N is the positional (index) form.
#
# The target browser/device should be CONNECTED when you run this: restored
# tabs are delivered live via ui.command{tab.create}. Requires curl + jq.
# NOTE: --url is REQUIRED on purpose (no default) -- never point tooling at a
# server you did not intend.
set -euo pipefail

URL="" TOKEN="${FRESHELL_TOKEN:-}" DEVICE="" GENERATION="" GENERATION_ID="" COMPONENTS="" DRY_RUN=false LIST=false
PANES=()   # repeatable --pane "tabKey#paneId": restore ONLY these panes (targeted remediation)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --device) DEVICE="$2"; shift 2 ;;
    --generation) GENERATION="$2"; shift 2 ;;
    --generation-id) GENERATION_ID="$2"; shift 2 ;;
    --components) COMPONENTS="$2"; shift 2 ;;   # comma-separated generation ids (the deploy bundle)
    --pane) PANES+=("$2"); shift 2 ;;           # repeatable; server rejects unknown keys fail-closed
    --dry-run) DRY_RUN=true; shift ;;
    --list) LIST=true; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$URL" ]] || { echo "ERROR: --url is required" >&2; exit 2; }
[[ -n "$TOKEN" ]] || { echo "ERROR: --token (or FRESHELL_TOKEN) is required" >&2; exit 2; }

auth=(-H "x-auth-token: ${TOKEN}")

# Print a loud failure WITHOUT masking the server's refusal: curl runs with
# --fail-with-body so an HTTP error still yields the response body, and the
# server's explanation (e.g. the 409 "restore requires exactly one connected
# browser" gate) reaches the operator. Prefers the JSON .message/.error field,
# falls back to the raw body, and keeps the generic hint when there is no body.
#   $1 = what failed, $2 = generic hint, $3 = response body (may be empty)
fail_loud() {
  local msg=""
  if [[ -n "$3" ]]; then
    msg=$(jq -r '.message // .error // empty' <<<"$3" 2>/dev/null) || msg=""
    printf 'ERROR: %s: %s\n' "$1" "${msg:-$3}" >&2
  else
    printf 'ERROR: %s (%s)\n' "$1" "$2" >&2
  fi
  exit 1
}

if $LIST; then
  resp=$(curl --fail-with-body -sS "${auth[@]}" "${URL}/api/tabs-sync/snapshots") ||
    fail_loud "list request failed" "URL/token correct? server up?" "${resp:-}"
  jq -r '
    .devices[] | .deviceId as $d | .generations[] |
    "\($d)\tgen=\(.generation)\tid=\(.generationId)\trev=\(.snapshotRevision)\trecords=\(.recordCount)\tcapturedAt=\(.capturedAt)\tlabel=\(.deviceLabel)"' <<<"$resp"
  exit 0
fi

[[ -n "$DEVICE" ]] || { echo "ERROR: --device is required (try --list)" >&2; exit 2; }

# Send a selector ONLY when explicitly asked; otherwise the server restores the
# coherent union (the safe multi-client default). Priority mirrors the server:
# --components (immutable multi-client bundle) > --generation-id > --generation.
body=$(jq -n --arg d "$DEVICE" --argjson dry "$DRY_RUN" '{deviceId: $d, dryRun: $dry}')
sel="union"
if [[ -n "$COMPONENTS" ]]; then
  # Split the CSV into a JSON string array (no single-client substitution).
  comps=$(jq -Rn --arg c "$COMPONENTS" '$c | split(",") | map(select(length>0))')
  body=$(jq --argjson c "$comps" '. + {components: $c}' <<<"$body"); sel="components=$COMPONENTS"
elif [[ -n "$GENERATION_ID" ]]; then
  body=$(jq --arg g "$GENERATION_ID" '. + {generationId: $g}' <<<"$body"); sel="generationId=$GENERATION_ID"
elif [[ -n "$GENERATION" ]]; then
  body=$(jq --argjson g "$GENERATION" '. + {generation: $g}' <<<"$body"); sel="generation=$GENERATION"
fi
# Targeted remediation (deploy-tab-diff): restore ONLY the named panes. Each
# --pane value becomes one JSON string; the server 400s on unknown keys and
# reports unselected panes as skipped{not-selected} -- never a silent drop.
if [[ ${#PANES[@]} -gt 0 ]]; then
  panes_json=$(printf '%s\0' "${PANES[@]}" | jq -Rs 'split("\u0000") | map(select(length>0))')
  body=$(jq --argjson p "$panes_json" '. + {panes: $p}' <<<"$body")
  sel="$sel panes=${#PANES[@]}"
fi
resp=$(curl --fail-with-body -sS "${auth[@]}" -H 'content-type: application/json' \
  -d "$body" "${URL}/api/tabs-sync/restore") ||
  fail_loud "restore request failed" "is the snapshot/device id right? try --list" "${resp:-}"

echo "== restore ${DEVICE} (${sel}) =="
echo "$resp" | jq -r '
  (.restored[] | "RESTORED  \(.kind)\t\(.tabKey)  tabId=\(.tabId)  terminalId=\(.terminalId // "-")"),
  (.skipped[]  | "SKIPPED   \(.kind)\t\(.tabKey)  reason=\(.reason)"),
  (.failed[]   | "FAILED    \(.kind)\t\(.tabKey)  reason=\(.reason // "-")  status=\(.status // "-")  \(.error // "" | tostring)")'
restored=$(echo "$resp" | jq '.restored | length')
skipped=$(echo "$resp" | jq '.skipped | length')
failedn=$(echo "$resp" | jq '.failed | length')
echo "-- restored=${restored} skipped=${skipped} failed=${failedn}"
[[ "$failedn" == "0" ]] || exit 1
```

- [x] **Step 2: Verify the script standalone (no browser)**

Manual smoke against an ephemeral server (NEVER :3001/:3002). SAFE by
construction (`:1720`): the server is started in its OWN process group via
`setsid`, and a `trap ... EXIT` cleanup ALWAYS runs — it kills ONLY the recorded
PID after verifying identity (`kill -0` + `/proc/<pid>/cmdline` contains our
throwaway `$THOME`), never signals a reused/foreign PID, and removes the temp
dir. Any intermediate failure still cleans up (no leaked server, no leaked HOME).

```bash
set -euo pipefail
# NOTE: the on-disk dir is the ENCODED device id (encode_device_id("dev-1")
# escapes '-' -> "dev_2d1"), and the filename is <enc(client)>-<capturedAt:020>-r<rev:012>.json.
THOME=$(mktemp -d)
SRV=""
cleanup() {
  # Kill ONLY the server we spawned, and ONLY if that exact PID is (still) OUR
  # server. An `env FRESHELL_HOME=... command` assignment is NOT in the child's
  # argv (env execs the target), so check /proc/<pid>/ENVIRON -- NUL-separated
  # KEY=VALUE pairs -- for this run's unique $THOME. Never signal a PID we did
  # not spawn or that was reused by another process, and NEVER delete the home
  # out from under a live process we refused to kill.
  if [[ -n "$SRV" ]] && kill -0 "$SRV" 2>/dev/null; then
    if tr '\0' '\n' < "/proc/$SRV/environ" 2>/dev/null | grep -qx -- "FRESHELL_HOME=$THOME"; then
      kill "$SRV" 2>/dev/null || true
      wait "$SRV" 2>/dev/null || true
    else
      echo "cleanup: PID $SRV is not our server (env mismatch/reused pid); NOT killing it and NOT removing $THOME" >&2
      return 0
    fi
  fi
  rm -rf "$THOME"
}
trap cleanup EXIT
mkdir -p "$THOME/.freshell/tabs-snapshots/dev_2d1"
cat > "$THOME/.freshell/tabs-snapshots/dev_2d1/c1-00000000000000002000-r000000000003.json" <<'EOF'
{ "deviceId": "dev-1", "deviceLabel": "Dev", "clientInstanceId": "c1",
  "serverInstanceId": "s", "snapshotRevision": 3, "capturedAt": 2000,
  "records": [{ "tabKey": "dev-1:t1", "tabId": "t1", "tabName": "sh", "status": "open",
    "revision": 1, "updatedAt": 2000, "paneCount": 1,
    "panes": [{ "paneId": "p1", "kind": "terminal", "payload": { "mode": "shell" } }] }] }
EOF
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
# setsid -> the server leads its own process group ($THOME appears in the child's
# ENVIRONMENT via FRESHELL_HOME -- /proc/<pid>/environ -- which the cleanup match
# keys on). AUTH_TOKEN must be >=16 chars or the server REFUSES TO START
# (validate_auth_token, crates/freshell-server/src/main.rs). Check main.rs:16-40
# for the exact env names (token/port) the binary reads; adjust if they differ.
TOK=devtok-0123456789abcdef
setsid env FRESHELL_HOME="$THOME" AUTH_TOKEN="$TOK" PORT="$PORT" ./target/release/freshell-server &
SRV=$!
sleep 2
scripts/restore-tabs.sh --url "http://127.0.0.1:$PORT" --token "$TOK" --list
scripts/restore-tabs.sh --url "http://127.0.0.1:$PORT" --token "$TOK" --device dev-1 --dry-run
# cleanup runs on EXIT (success or failure) -- no explicit kill/rm needed here.
```

Expected: `--list` prints one `dev-1 gen=0 id=<digest>` line; `--dry-run` prints one RESTORED line with `tabId=null` and exits 0. Do NOT run a REAL (non-dry) restore here — with no browser connected the exactly-one-client gate returns 409 by design; the real create path (with a connected browser) is proven end-to-end in Task 5. (Confirm the binary's env names for port/token in `crates/freshell-server/src/main.rs` before running; the RustServer harness `boot()` shows the exact ones it passes. `FRESHELL_HOME` appears in the process's `/proc/<pid>/environ` — NOT its `cmdline`: `env` execs the server, so the assignment becomes part of the child's environment, not its argv — which is what cleanup greps (NUL-separated, hence `tr '\0' '\n'`); if your platform lacks `/proc`, use a process-group kill `kill -- -"$SRV"` on the setsid group instead, still gated on `kill -0`.)

- [x] **Step 3: Commit**

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
- Consumes: `RustServer` (`../helpers/rust-server.js`, constructed DIRECTLY — ephemeral-only, never `createE2eServerHandle`) + `TestHarness` (`../helpers/test-harness.js`); `POST /api/tabs` (envelope `.data`), `GET /api/tabs-sync/snapshots[/{device}]`, `GET /api/terminals` (RAW array), `scripts/restore-tabs.sh`; the fake-codex argv-recorder wiring — copy it EXACTLY from `codex-terminal-bounce-rust.spec.ts` (fake CLI is correct here: deliverable 1 proves identity plumbing, deliverable 2 proves real CLIs). The recorded argv (`FAKE_CODEX_ARGV_LOG`) is the RESUME PROOF: after restore, the fake codex's argv MUST contain the adjacent pair `resume <sessionId>` (identical to how the sibling proves same-session — a Redux `sessionRef` echo alone does NOT prove the server passed resume args).
- Produces: the committed acceptance test for deliverable 1.

- [x] **Step 1: Write the spec (failing only until Tasks 1-4 are in)**

Skeleton (fill the fake-codex install + `setupHome` config/session seeding by
copying the exact blocks from `codex-terminal-bounce-rust.spec.ts:49-165` — do
not invent your own):

```ts
import { test, expect } from '../helpers/fixtures.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'

const run = promisify(execFile)
const CODEX_SESSION_ID = '11111111-2222-4333-8444-555555555555'

// Fake-CLI argv proof (copied from codex-terminal-bounce-rust.spec.ts:75-85).
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[] })
}
function hasResumePair(argv: string[], sessionId: string): boolean {
  const idx = argv.indexOf('resume')
  return idx >= 0 && argv[idx + 1] === sessionId
}

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
    // EPHEMERAL-ONLY: construct RustServer directly (throwaway port + mkdtemp
    // HOME). NEVER createE2eServerHandle(process.env, ...) -- with
    // FRESHELL_E2E_TARGET_URL set it would return an ExternalServer pointing at
    // a live server (and it has no restart()).
    const argLogPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'fakecodex-')), 'argv.jsonl')
    const server = new RustServer({
      env: { /* CODEX_CMD=<fake codex path> + FAKE_CODEX_ARGV_LOG=argLogPath, copied from the sibling */ },
      setupHome: async (homeDir) => { /* config.json + codex session seeding, copied from the sibling */ },
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

      // -- RESUME PROOF (not identity-echo only): the restore re-spawned codex
      //    with `resume <sessionId>` argv. A Redux sessionRef could survive even
      //    if the server ignored it, so assert the RECORDED argv, exactly like
      //    codex-terminal-bounce-rust.spec.ts:209-210. --
      await expect(async () => {
        const entries = await readArgvLog(argLogPath)
        expect(entries.some((e) => hasResumePair(e.argv, CODEX_SESSION_ID)),
          'restore must exec `codex resume <sessionId>`').toBe(true)
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

- [x] **Step 2: Register the spec (`rust-chromium` testMatch + match-all testIgnore)**

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

- [x] **Step 3: Run it twice**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium snapshot-restore-rust.spec.ts --repeat-each=2`
Expected: 2 passed. (Build the release server first if needed: `cargo build --release -p freshell-server` — the harness also builds on demand.)

- [x] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/snapshot-restore-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): snapshot->wipe->restore round-trip proves tabs come back with the same sessions

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## DELIVERABLE 2 — The continuity smoke test (real CLIs, ≤5-minute budget)

### Task 6: Harness binary override + real-CLI offline-resume probes

**Files:**
- Modify: `test/e2e-browser/helpers/rust-server.ts` (export `resolveRustServerBin` + `rustServerBinSha256`; call them in `boot()`)
- Create: `test/e2e-browser/helpers/rust-server-bin.test.ts` (override self-tests, `:2015`)
- Probe artifacts: findings recorded as the header comment of Task 7's spec + in `docs/plans/2026-07-22-continuity-smoke-evidence.md` (created in Task 8)

**Interfaces:**
- Consumes: `RustServer.boot()` (`rust-server.ts:296`, calls `ensureRustServerBuilt()`).
- Produces: env override `FRESHELL_E2E_RUST_SERVER_BIN` — when set, `boot()` uses that binary instead of building HEAD; when set but MISSING, a non-regular-file, or non-executable it ABORTS (fail-closed, `:2015`). Resolution is the exported pure `resolveRustServerBin(env, buildHead)` (unit-tested: missing→throw, non-exec→throw, valid→selected, unset→built) and `boot()` logs the resolved path + `sha256` so Task 8's evidence records exactly which binary ran. Needed by Task 8's historical-bug proof.

- [x] **Step 1: Add the fail-closed override as a UNIT-TESTABLE pure function (test infra, not frozen)**

The override is a relied-upon regression gate, so the RESOLUTION logic is a pure,
exported function (`resolveRustServerBin`) that `boot()` calls — this lets it be
tested in isolation (missing / non-executable / valid), which a Playwright spec
that actually starts a server cannot cheaply do. Add to `rust-server.ts`:

```ts
import { createHash } from 'node:crypto'

/** Resolve the freshell-server binary the harness will spawn. FAIL CLOSED
 *  (:2015): when `FRESHELL_E2E_RUST_SERVER_BIN` is set it MUST be an executable
 *  file or this THROWS — a typo/stale/non-exec path must never silently fall back
 *  to the FIXED HEAD binary (which would make the historical-regression proof run
 *  the wrong binary and pass). Returns `{ bin, source }`; `source` is `'override'`
 *  or `'built'`. `buildHead` is injected so tests need not compile HEAD. */
export function resolveRustServerBin(
  env: NodeJS.ProcessEnv,
  buildHead: () => string = ensureRustServerBuilt,
): { bin: string; source: 'override' | 'built' } {
  const overrideBin = env.FRESHELL_E2E_RUST_SERVER_BIN
  if (overrideBin !== undefined && overrideBin.trim() !== '') {
    const p = overrideBin.trim()
    let st: fs.Stats
    try {
      st = fs.statSync(p)
    } catch {
      throw new Error(`FRESHELL_E2E_RUST_SERVER_BIN is set but does not exist: ${p}`)
    }
    if (!st.isFile()) {
      throw new Error(`FRESHELL_E2E_RUST_SERVER_BIN is set but is not a regular file: ${p}`)
    }
    try {
      fs.accessSync(p, fs.constants.X_OK)
    } catch {
      throw new Error(`FRESHELL_E2E_RUST_SERVER_BIN is set but is not executable: ${p}`)
    }
    return { bin: p, source: 'override' }
  }
  return { bin: buildHead(), source: 'built' }
}

/** sha256 of a binary, for evidence that the SELECTED override was actually run. */
export function rustServerBinSha256(bin: string): string {
  return createHash('sha256').update(fs.readFileSync(bin)).digest('hex')
}
```

In `boot()`, replace `const bin = ensureRustServerBuilt()` with:

```ts
    const { bin, source } = resolveRustServerBin(process.env)
    if (source === 'override') {
      // eslint-disable-next-line no-console
      console.log(`[rust-server] using FRESHELL_E2E_RUST_SERVER_BIN=${bin} sha256=${rustServerBinSha256(bin).slice(0, 12)}`)
    }
```

- [x] **Step 1b: Override self-tests (the fail-closed gate is itself tested)**

Add `test/e2e-browser/helpers/rust-server-bin.test.ts` (a helper-suite vitest,
run by `npm run test:e2e:helpers`):

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveRustServerBin, rustServerBinSha256 } from './rust-server.js'

describe('resolveRustServerBin (fail-closed override, :2015)', () => {
  const buildHead = () => '/BUILT/head/freshell-server' // sentinel: never used on the override paths
  it('aborts nonzero-equivalent (throws) when the override path is MISSING', () => {
    expect(() => resolveRustServerBin(
      { FRESHELL_E2E_RUST_SERVER_BIN: '/no/such/binary' }, buildHead)).toThrow(/does not exist/)
  })
  it('THROWS when the override is a non-executable file', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-')), 'bin')
    fs.writeFileSync(f, 'not exec', { mode: 0o644 })
    expect(() => resolveRustServerBin({ FRESHELL_E2E_RUST_SERVER_BIN: f }, buildHead))
      .toThrow(/not executable/)
  })
  it('SELECTS the override (never buildHead) for a valid executable + exposes its sha', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-')), 'server')
    fs.writeFileSync(f, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const r = resolveRustServerBin({ FRESHELL_E2E_RUST_SERVER_BIN: f }, buildHead)
    expect(r).toEqual({ bin: f, source: 'override' })
    expect(rustServerBinSha256(f)).toMatch(/^[0-9a-f]{64}$/)
  })
  it('falls back to the built HEAD binary when the override is UNSET', () => {
    expect(resolveRustServerBin({}, buildHead)).toEqual({ bin: '/BUILT/head/freshell-server', source: 'built' })
  })
})
```

Run: `npm run test:e2e:helpers` (override self-tests PASS), then
`npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium harness-01-rust-server.spec.ts`
Expected: both PASS (harness self-test unaffected when the env var is unset).

- [x] **Step 2: Probe — does each REAL CLI render seeded history offline?**

The smoke test's strongest assertion is "seeded MARKER text visible in the
resumed pane" with NO API keys. Verify each CLI supports that before writing
the spec. All probes in a throwaway HOME; `script -qec` provides a PTY. Use
UUIDv4 session ids.

```bash
REAL_HOME=$HOME
PROBE=$(mktemp -d)
trap 'rm -rf "$PROBE"' EXIT
CWD="$PROBE/proj"; mkdir -p "$CWD"
CID=$(python3 -c 'import uuid; print(uuid.uuid4())')   # codex
ALID=$(python3 -c 'import uuid; print(uuid.uuid4())')  # amplifier also requires UUID
CLID=$(python3 -c 'import uuid; print(uuid.uuid4())')  # claude

# codex rollout (real layout: sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl)
D="$PROBE/.codex/sessions/2026/07/22"; mkdir -p "$D"
cat > "$D/rollout-2026-07-22T08-00-00-$CID.jsonl" <<EOF
{"timestamp":"2026-07-22T08:00:00.000Z","type":"session_meta","payload":{"session_id":"$CID","id":"$CID","timestamp":"2026-07-22T08:00:00.000Z","cwd":"$CWD","originator":"codex_cli_rs","cli_version":"0.145.0","source":"cli","thread_source":"user","model_provider":"openai","history_mode":"legacy"}}
{"timestamp":"2026-07-22T08:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"MARKER-CODEX-7f3a the aubergine protocol"}]}}
{"timestamp":"2026-07-22T08:00:01.500Z","type":"event_msg","payload":{"type":"user_message","message":"MARKER-CODEX-7f3a the aubergine protocol","kind":"plain"}}
{"timestamp":"2026-07-22T08:00:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ack MARKER-CODEX-7f3a"}]}}
{"timestamp":"2026-07-22T08:00:02.500Z","type":"event_msg","payload":{"type":"agent_message","message":"ack MARKER-CODEX-7f3a"}}
EOF
# Codex requires the real auth file copied read-only into the throwaway HOME,
# a trusted-project entry, and one Enter at its resume-cwd picker.
cp "$REAL_HOME/.codex/auth.json" "$PROBE/.codex/auth.json"
cat > "$PROBE/.codex/config.toml" <<EOF
[projects."$CWD"]
trust_level = "trusted"
EOF
(cd "$CWD" && printf '\r' | HOME="$PROBE" timeout 30 \
  script -qec "codex resume $CID" /dev/null > /tmp/probe-codex.out || true)
grep -c "MARKER-CODEX-7f3a" /tmp/probe-codex.out

# amplifier session dir: project slug replaces `/` only; dots are preserved.
AMP_SLUG=${CWD//\//-}
AD="$PROBE/.amplifier/projects/$AMP_SLUG/sessions/$ALID"; mkdir -p "$AD"
cat > "$AD/metadata.json" <<EOF
{"session_id":"$ALID","created":"2026-07-22T08:00:00.000000+00:00","bundle":"bundle:anchors","model":"anthropic/claude-fable-5","turn_count":1,"working_dir":"$CWD"}
EOF
printf '%s\n%s\n' \
  '{"role":"user","content":"MARKER-AMP-9c1e the cerulean ledger"}' \
  '{"role":"assistant","content":"ack MARKER-AMP-9c1e"}' > "$AD/transcript.jsonl"
(cd "$CWD" && HOME="$PROBE" timeout 30 script -qec "amplifier resume $ALID" /dev/null > /tmp/probe-amp.out || true)
grep -c "MARKER-AMP-9c1e" /tmp/probe-amp.out

# claude project session: project slug replaces BOTH `/` and `.`.
MUNGED=${CWD//\//-}; MUNGED=${MUNGED//./-}
CD="$PROBE/.claude/projects/$MUNGED"; mkdir -p "$CD"
CUUID=$(python3 -c 'import uuid; print(uuid.uuid4())')
AUUID=$(python3 -c 'import uuid; print(uuid.uuid4())')
cat > "$CD/$CLID.jsonl" <<EOF
{"parentUuid":null,"isSidechain":false,"type":"user","uuid":"$CUUID","sessionId":"$CLID","timestamp":"2026-07-22T08:00:01.000Z","cwd":"$CWD","userType":"external","version":"2.1.218","message":{"role":"user","content":"MARKER-CLAUDE-4b8d the vermilion archive"}}
{"parentUuid":"$CUUID","isSidechain":false,"type":"assistant","uuid":"$AUUID","sessionId":"$CLID","timestamp":"2026-07-22T08:00:02.000Z","cwd":"$CWD","userType":"external","version":"2.1.218","message":{"role":"assistant","content":[{"type":"text","text":"ack MARKER-CLAUDE-4b8d"}]}}
EOF
cat > "$PROBE/.claude.json" <<EOF
{"hasCompletedOnboarding":true,"theme":"dark","projects":{"$CWD":{"hasTrustDialogAccepted":true,"allowedTools":[],"history":[]}}}
EOF
(cd "$CWD" && env -u ANTHROPIC_API_KEY HOME="$PROBE" timeout 30 \
  script -qec "claude --resume $CLID" /dev/null > /tmp/probe-claude.out || true)
grep -c "MARKER-CLAUDE-4b8d" /tmp/probe-claude.out
```

For each CLI record: (a) does resume render the MARKER offline (grep count ≥ 1)?
(b) if not, does it at least accept the session id? Iterate the fixture shape
until the CLI renders it, or conclude it genuinely cannot render offline.
**Fallback rule (spec-mandated), corrected so the downgrade is NON-VACUOUS:** any
leg whose CLI cannot render history offline downgrades to a SAME-SESSION proof
that has TWO independent parts, BOTH required — a Redux echo alone is
insufficient because Redux can retain the requested `sessionRef` even if the
server ignored it and started a fresh session:
  1. **Server acted on the resume (authoritative):** the Rust logger writes a
     `terminal.created` record with `resume_applied = <bool>` (verified
     `crates/freshell-terminal/src/registry.rs:588-594`) to
     `<home>/.freshell/logs/rust-server.jsonl`. Read the logs via
     `fs.readdir(info.logsDir)` + concat (exactly as
     `codex-terminal-bounce-rust.spec.ts:89-93`) and assert a `terminal.created`
     record for this leg's `mode` with `resume_applied: true`. This PROVES the
     server constructed CLI args with a resume id — a fresh-session bug (the
     historical codex defect) produces `resume_applied: false` and FAILS here.
  2. **Same id round-tripped (corroborating):** the resumed pane's Redux
     `content.sessionRef.sessionId` is unchanged via
     `harness.getPaneLayout(tabId).content.sessionRef`.
Do NOT depend on `GET /api/terminals` `sessionRef` (it is OMITTED for
codex/shell) nor on `info.debugLogPath` (the debug path is the WRONG filename for
the Rust server — `rust-server.ts:376`; the logger never writes it). The
`terminal.created` record carries `resume_applied` (a bool), not the id, so part
2 supplies the id and part 1 supplies the server-acted proof. For a FAKE-CLI leg
a stronger raw-argv proof is available (that CLI's argv recorder, e.g.
`FAKE_CODEX_ARGV_LOG` + `hasResumePair`); real CLIs have no argv log, so their
downgrade proof is parts 1+2 above.
Document the downgrade + probe evidence in the spec header comment AND the
evidence file. Also record whether each CLI needs auth state
copied into the throwaway HOME to even start (e.g. `~/.codex/auth.json`,
`~/.claude/.credentials.json`) — resume-render needs no API calls, but the
binary may refuse to start unauthenticated; if so, the spec's `setupHome`
copies ONLY the auth file from the real HOME (read-only copy, never written
back).

- [x] **Step 3: Commit the harness knob**

```bash
git add test/e2e-browser/helpers/rust-server.ts test/e2e-browser/helpers/rust-server-bin.test.ts
git commit -m "test(e2e): fail-closed FRESHELL_E2E_RUST_SERVER_BIN override (+ self-tests) for historical-regression proof runs

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
- Consumes: `RustServer` (constructed DIRECTLY — `setupHome`, `server.restart()`, `server.stop()`; NEVER `createE2eServerHandle`) + `TestHarness` (`waitForHarness`/`waitForConnection`/`getWsReadyState`/`getPaneLayout`), sidebar interactions (mirror `sidebar-click-resume.spec.ts:215-235`), `POST /api/tabs` with `sessionRef` (envelope `.data`), `GET /api/terminals` (RAW array), `GET /api/terminals/{id}/search?query=<marker>` → `.matches` (**the handler reads the `query` param, verified `terminals.rs:176`; `?q=` returns HTTP 400**) (server-side scrollback mirror — the strongest render assertion), Task 6 probe findings.
- Produces: `npm run smoke:continuity` — the pre-deploy gate. NOT run by `chromium`/`rust-chromium`/`legacy-chromium`.

- [x] **Step 1: Register the project + npm script FIRST (so the spec never leaks into the default matrix)**

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

Register the smoke project CONDITIONALLY (dedicated, and genuinely outside the
default matrix): a project-less Playwright run executes EVERY registered
project, so an unconditionally-registered project WOULD still run in bare
`npx playwright test` invocations even with the spec in `RUST_ONLY_SPECS` on
the match-all projects. Gate the registration itself behind an explicit
request (this is exactly what shipped in `test/e2e-browser/playwright.config.ts`):

```ts
    // CONTINUITY SMOKE (pre-deploy gate): REAL freshell-server binary + REAL
    // codex/amplifier/claude CLIs from PATH. Run via `npm run smoke:continuity`.
    // Registered CONDITIONALLY: included only when explicitly requested via
    // FRESHELL_SMOKE=1 (set by the `smoke:continuity` npm script) or an
    // explicit `--project=continuity-smoke` CLI arg, so a project-less run
    // can never pick it up. The spec also stays in RUST_ONLY_SPECS so no
    // match-all project ever matches it even when the project IS registered.
    ...(process.env.FRESHELL_SMOKE
      || process.argv.includes('--project=continuity-smoke')
      || (process.argv.includes('--project')
        && process.argv[process.argv.indexOf('--project') + 1] === 'continuity-smoke')
      ? [
        {
          name: 'continuity-smoke',
          use: { ...devices['Desktop Chrome'], e2eServerKind: 'rust' as const },
          testMatch: [/continuity-smoke\.spec\.ts$/],
        },
      ] : []),
```

Verify exclusion (with and without CI): the smoke spec must appear ONLY under
`[continuity-smoke]`, and `snapshot-restore-rust`/`deploy-tab-diff-rust` must
NOT appear under `[chromium]`:
```bash
set -euo pipefail
CFG=test/e2e-browser/playwright.config.ts
FRESHELL_SMOKE=1 npx playwright test --config "$CFG" \
  --project=continuity-smoke --list | tee /tmp/continuity-smoke.list
grep -qE '^[[:space:]]*\[continuity-smoke\].*continuity-smoke\.spec\.ts' /tmp/continuity-smoke.list

npx playwright test --config "$CFG" --project=chromium --list \
  | tee /tmp/continuity-chromium.list
if grep -Eq 'continuity-smoke|snapshot-restore-rust|deploy-tab-diff-rust' \
    /tmp/continuity-chromium.list; then
  echo "FATAL: a Rust-only spec leaked into chromium" >&2
  exit 1
fi

CI=1 npx playwright test --config "$CFG" \
  --project=firefox --project=webkit --list | tee /tmp/continuity-ci-match-all.list
if grep -Eq 'continuity-smoke|snapshot-restore-rust|deploy-tab-diff-rust' \
    /tmp/continuity-ci-match-all.list; then
  echo "FATAL: a Rust-only spec leaked into a CI match-all project" >&2
  exit 1
fi
```
Neither listing may show any of the three under `[chromium]`, `[firefox]`, or `[webkit]`.

`package.json` scripts:

```json
"smoke:continuity": "cross-env FRESHELL_SMOKE=1 playwright test --config test/e2e-browser/playwright.config.ts --project=continuity-smoke"
```

- [x] **Step 2: Write the smoke spec**

One scenario, one server, one page. Constants: three MARKERs + three session
ids as in the Task 6 probe. Structure (fill fixture-seeding bodies from the
probe's final working shapes; header comment records probe results and any
per-CLI fallback downgrade):

```ts
import { test, expect } from '../helpers/fixtures.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { RustServer } from '../helpers/rust-server.js'
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
    test.setTimeout(300_000) // hard cap 5 min; target wall clock <=5 min (single worker, tight polls)
    // EPHEMERAL-ONLY: construct RustServer directly (throwaway port + mkdtemp
    // HOME) so this can never touch an external/live target.
    const server = new RustServer({
      // NO fake-CLI env: real codex/amplifier/claude from PATH on purpose.
      setupHome: async (homeDir) => {
        const cwd = path.join(homeDir, 'proj'); await fs.mkdir(cwd, { recursive: true })
        // seed codex rollout under .codex/sessions/2026/07/22/rollout-...-<id>.jsonl  (probe shape)
        // seed amplifier .amplifier/projects/smoke/sessions/<id>/{metadata.json,transcript.jsonl}
        // seed claude .claude/projects/<munged-cwd>/<id>.jsonl                        (probe shape)
        // copy auth files ONLY if the Task 6 probe proved they are required to start
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
              `${info.baseUrl}/api/terminals/${t.terminalId}/search?query=${encodeURIComponent(MARKERS[p].slice(0, 20))}`,
              { headers: auth })).json()
            // s.matches is the search response array (terminals.rs:392); the
            // handler reads the `query` param (terminals.rs:176) -- `?q=` -> 400.
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
  leg's `search`/`.matches` assertion and replace it with the NON-VACUOUS
  same-session proof from Task 6's fallback rule — BOTH (1) a `terminal.created`
  log record for that `mode` with `resume_applied: true` (read from
  `info.logsDir` via `fs.readdir` + concat, as `codex-terminal-bounce-rust.spec.ts:89-93`)
  AND (2) the resumed pane's Redux `content.sessionRef.sessionId` unchanged (via
  `paneByMode`) — and say so in the header comment + evidence file. Do NOT use
  `info.debugLogPath` (wrong filename) and do NOT rely on the Redux echo alone.
- Keep total runtime ≤ 5 min (the hard cap): single worker, no `--repeat-each`,
  tight polls.

- [x] **Step 3: Run to verify it fails/errors before fixture tuning, then passes**

Run: `npm run smoke:continuity`
Iterate fixture shapes (per Task 6 probes) until: PASS with all three legs on
their strongest supported assertion. Then run once more: PASS 2x consecutive.
Record wall-clock (target ≤ 5 min — the single budget stated in the Goal, the
`test.setTimeout(300_000)` cap, and the final checklist). If a run exceeds 5 min,
tighten polls/worker rather than loosening any of those three numbers.

- [x] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/continuity-smoke.spec.ts test/e2e-browser/playwright.config.ts package.json
git commit -m "test(smoke): real-CLI continuity smoke (<=5 min) as a pre-deploy gate (npm run smoke:continuity)

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

- [x] **Step 1: Build the pre-fix server binary in an ephemeral worktree**

```bash
cd <worktree-root>
git worktree add /tmp/freshell-pre-136b9e94 136b9e94~1
(cd /tmp/freshell-pre-136b9e94 && cargo build --release -p freshell-server)
```

(Build is read-only w.r.t. this repo's frozen paths; the temp worktree is
removed in Step 4.)

- [x] **Step 2: Run the smoke against the OLD binary — expect the codex leg to FAIL**

Exit-nonzero alone is INSUFFICIENT (`:2402`): a startup/auth/browser/env failure
would also exit nonzero without proving the codex resume assertion regressed. So
this step runs the smoke with the Playwright JSON reporter and MACHINE-CHECKS the
failed assertion's message: it MUST be the codex leg's BEHAVIORAL assertion
(`MARKER rendered by real CLI` or `same session`), and MUST NOT be a control-leg
(amplifier/claude) assertion nor an infrastructure error. Crucially the codex leg
asserts BEHAVIOR (seeded MARKER rendered via the server scrollback `search`, and
the Redux `sessionRef` round-trip) — NEVER the `resume_applied` LOG field — so a
pre-fix failure there isolates the codex-resume-derivation regression from
`136b9e94`'s CONCURRENT `terminal.created` logging change.

```bash
set -o pipefail
BIN=/tmp/freshell-pre-136b9e94/target/release/freshell-server
[ -x "$BIN" ] || { echo "FATAL: historical binary missing/not executable: $BIN" >&2; exit 1; }
# Record the resolved binary identity (path + built-from sha + sha256 of the file).
echo "historical binary: $BIN (built from $(git -C /tmp/freshell-pre-136b9e94 rev-parse HEAD), sha256 $(sha256sum "$BIN" | cut -d' ' -f1))" \
  | tee /tmp/smoke-pre-fix.binid
JSON=/tmp/smoke-pre-fix.json
# Capture npm's exit code from PIPESTATUS IMMEDIATELY after the pipeline.
# NO trailing `|| true`: that runs `true` as a new command and OVERWRITES
# PIPESTATUS, so `code` would always read true's 0. `set +e` keeps the
# expected-to-fail pipeline from aborting an errexit shell instead.
set +e
FRESHELL_E2E_RUST_SERVER_BIN="$BIN" PLAYWRIGHT_JSON_OUTPUT_NAME="$JSON" \
  npm run smoke:continuity -- --reporter=json 2>&1 | tee /tmp/smoke-pre-fix.out
code=${PIPESTATUS[0]}
set -e
[ "$code" -ne 0 ] || { echo "REGRESSION-PROOF FAILED: historical binary unexpectedly PASSED the smoke (exit 0)" >&2; exit 1; }
[ -f "$JSON" ] || { echo "FATAL: no JSON report produced ($JSON)" >&2; exit 1; }
# Collect every failed-assertion message from the Playwright JSON report.
errs=$(jq -r '[.. | objects | select(has("error")) | .error.message? // empty] | .[]' "$JSON")
[ -n "$errs" ] || { echo "FATAL: nonzero exit but NO failed-assertion error in the JSON (env/startup failure, not a regression)" >&2; exit 1; }
# (a) The failing assertion IS the codex BEHAVIORAL assertion.
echo "$errs" | grep -qiE 'codex.*(MARKER rendered by real CLI|same session|history never rendered|picker never settled)|(MARKER rendered by real CLI|same session|history never rendered|picker never settled).*codex' \
  || { echo "FATAL: the failing assertion is not the codex resume/MARKER behavior:" >&2; echo "$errs" >&2; exit 1; }
# (b) It is NOT a control-leg assertion and NOT an infra/env error.
if echo "$errs" | grep -qiE 'amplifier|claude'; then
  echo "FATAL: a control leg (amplifier/claude) is the failing assertion, not codex" >&2; echo "$errs" >&2; exit 1; fi
if echo "$errs" | grep -qiE 'waitForConnection|getWsReadyState|ECONNREFUSED|failed to (start|launch)|Executable doesn.t exist|net::ERR'; then
  echo "FATAL: the failure looks like an environment/infra error, not the codex regression" >&2; echo "$errs" >&2; exit 1; fi
echo "confirmed: historical binary FAILED on the codex resume/MARKER assertion (exit=$code), controls not implicated"
```

If the run instead fails for an unrelated reason (e.g. the old binary predates an
endpoint the spec uses — note `GET /api/terminals/{id}/search` DOES exist
pre-`136b9e94`, it shipped with `terminals.rs`; verify with
`git show 136b9e94~1:crates/freshell-server/src/terminals.rs | grep -n search`),
the machine-check above ABORTS loudly; adjust the spec to only use surfaces
present in both binaries, re-run Task 7's pass, then repeat this step.

- [x] **Step 3: Run at HEAD — expect PASS — and write the evidence file**

```bash
set -o pipefail
npm run smoke:continuity 2>&1 | tee /tmp/smoke-head.out
code=${PIPESTATUS[0]}
[ "$code" -eq 0 ] || { echo "HEAD smoke unexpectedly FAILED (exit=$code)" >&2; exit 1; }
echo "confirmed: HEAD PASSED (exit=0)"
```

Create `docs/plans/2026-07-22-continuity-smoke-evidence.md` (include the resolved historical-binary path + built-from sha from `/tmp/smoke-pre-fix.binid`):

```markdown
# Continuity smoke — regression-catch evidence (2026-07-22)

Proof that `npm run smoke:continuity` catches the identity-loss category:
run against `136b9e94~1` (real historical bug: codex terminal creates
ignored sessionRef) the codex leg FAILS; at HEAD (`<head sha>`) it PASSES.

## Probe findings (Task 6)
- codex resume offline render: <result>; auth file needed: <yes/no>
- amplifier resume offline render: <result>; downgrade applied: <none|log+id>
- claude --resume offline render: <result>; downgrade applied: <none|log+id>
- codex leg discriminator: BEHAVIORAL (MARKER render + Redux same-session), NEVER
  the `resume_applied` log field — so the pre-fix failure isolates the resume
  regression from `136b9e94`'s concurrent `terminal.created` logging change.

## FAIL @ 136b9e94~1 (binary override), exit=<n>
Historical binary (from `/tmp/smoke-pre-fix.binid`): `<resolved path>` built from `<sha>`, sha256 `<sha256>`.
Machine-checked failed assertion (from `/tmp/smoke-pre-fix.json`): the codex
`<MARKER rendered by real CLI | same session>` assertion; controls (amplifier/claude)
and infra were NOT the failing assertion (asserted in Step 2).
```text
<trimmed tail of /tmp/smoke-pre-fix.out — the failing codex assertion + summary>
```

## PASS @ HEAD, exit=0, wall clock <m>m<s>s
```text
<trimmed tail of /tmp/smoke-head.out — the 1 passed summary>
```
```

- [x] **Step 4: Clean up + commit**

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
  - `scripts/deploy-tab-diff.sh capture --url U --token T --out FILE` → **ATOMICALLY** (`:2544`) writes `{"capturedAt", "url", "devices": {"<deviceId>": <newest UNION snapshot>}, "terminals": [<raw /api/terminals array>], "bundles": {"<deviceId>": {"components": [<per-client component generation ids at capture>], "capturedAt": <n>}}}`. Capture fetches into a TEMP file with EXPLICIT per-request curl/jq status checks (never process-substitution failure masking), validates the assembled JSON's shape, THEN renames over `FILE` — any failure leaves a prior good `FILE` untouched and exits nonzero. The `bundles[deviceId].components` list is the IMMUTABLE recovery bundle remediation restores (`:2621`). Arbitrary device ids are handled safely: the device list is read NUL-delimited into a loop (`jq -j '... + "\u0000"'` + `while IFS= read -r -d ''`), each id is URL-encoded for its path segment (`jq -rn '$d|@uri'`), and the large snapshot/terminals documents are streamed into `jq` via temp files + `--slurpfile` (never `--argjson`, which would blow the OS arg-size limit at ~1 MiB-per-client scale).
  - `scripts/deploy-tab-diff.sh verify --url U --token T --before FILE [--after FILE]` → exit 0 when every previously-live identity pane came back with the SAME `sessionRef`; exit 1 with a loud pane-by-pane diff (`MISSING` / `FRESH (identity lost)` / `RE-POINTED` / `NOT RESPAWNED`) and, per diverged device, a TARGETED `restore-tabs.sh --components <bundle> --pane <tabKey#paneId>...` remediation (only the diverged panes, so healthy panes are never re-restored) otherwise. `--after FILE` (optional) feeds a synthetic after-state instead of fetching live — with `--after` supplied verify performs **ZERO network operations** (`:2619`): both the diff and the remediation read only local files. Used by the deterministic diff-engine test (Task 10); default fetches live.
  - Verify semantics (liveness gated on the BEFORE state, so no vacuous OK and no false red): **"live" means `status == "running"`** — the `/api/terminals` array includes `exited` terminals (verified `terminals.rs:704-708`), which are filtered OUT of both the before and after live sets so an exited id never causes a false `NOT RESPAWNED`. A pane is "counted" only if it had a `payload.sessionRef` OR its `payload.liveTerminal.terminalId` was ACTUALLY present-and-running in the before `/api/terminals` array. For each counted pane, find the same `(tabKey, paneId)` in the device's AFTER union snapshot: absent → `MISSING`; before had `sessionRef` and after doesn't → `FRESH`; both present but `sessionId`/`provider` differ → `RE-POINTED`; a genuinely-live-before pane whose after `liveTerminal.terminalId` is absent from the after RUNNING set → `NOT RESPAWNED`. **Coverage guard (full set-difference, `:2559`/`:2563`):** verify computes the COMPLETE set of running-at-capture terminals covered by NO persisted snapshot pane (binding the id to a jq variable before indexing — `. as $t | $covered | index($t)` — never `$covered | index(.)`, which would rebind `.` to the array) and FAILS loudly LISTING them if that set is nonempty (a PARTIAL-coverage gap fails too, not just all-or-none). Remediation prints, per diverged device, `restore-tabs.sh --components <bundle>` plus one `--pane <tabKey#paneId>` per diverged pane (the restore API's fail-closed selective mode) using the BEFORE file's `bundles[deviceId].components` — the immutable multi-client bundle (`:2621`), never a single-client `--generation-id`; if the before-file has no bundle for a device it FAILS LOUDLY for that device. The printed command is shell-quoted (`printf %q` for url/device/components) so a metacharacter id can't inject when copied.

- [x] **Step 1: Write the script**

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
URL="" TOKEN="${FRESHELL_TOKEN:-}" OUT="" BEFORE="" AFTER_IN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --before) BEFORE="$2"; shift 2 ;;
    --after) AFTER_IN="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$URL" && -n "$TOKEN" ]] || { echo "ERROR: --url and --token are required" >&2; exit 2; }
auth=(-H "x-auth-token: ${TOKEN}")

# Capture live server state. Device ids are read NUL-delimited (arbitrary ids may
# contain spaces/slashes), each is URL-encoded for its path segment, and the
# growing documents are streamed into jq via temp files + --slurpfile (never
# --argjson, which would exceed ARG_MAX at ~1 MiB-per-client scale).
#
# LOGICALLY COHERENT (:40): the generation index is fetched ONCE and .bundles
# is derived from THAT snapshot of it; after every other fetch completes, the
# index is re-fetched and compared -- if a tabs-sync push landed mid-capture
# (the two indexes disagree on any device's generation set), the capture is
# INCOHERENT and returns 3 so the caller can retry, never emitting an artifact
# whose .devices and .bundles describe different generations.
fetch_state() {
  local snaps_tmp snaps2_tmp dev_tmp term_tmp out_tmp d enc snap_tmp
  snaps_tmp=$(mktemp); snaps2_tmp=$(mktemp); dev_tmp=$(mktemp); term_tmp=$(mktemp); out_tmp=$(mktemp)
  _cleanup_fetch() { rm -f "$snaps_tmp" "$snaps2_tmp" "$dev_tmp" "$term_tmp" "$out_tmp"; }
  # EXPLICIT curl/jq status checks throughout (never rely on `set -e` propagating
  # through a function called in an `if`, nor through process substitution -- the
  # :2544 failure-masking hazard). Any failure -> return 1, no partial artifact.
  if ! curl -fsS "${auth[@]}" "${URL}/api/tabs-sync/snapshots" > "$snaps_tmp"; then
    echo "ERROR: GET /api/tabs-sync/snapshots failed" >&2; _cleanup_fetch; return 1; fi
  jq -e . "$snaps_tmp" >/dev/null || { echo "ERROR: /snapshots not JSON" >&2; _cleanup_fetch; return 1; }
  printf '{}' > "$dev_tmp"
  while IFS= read -r -d '' d; do
    [[ -n "$d" ]] || continue
    enc=$(jq -rn --arg d "$d" '$d|@uri')
    snap_tmp=$(mktemp)
    if ! curl -fsS "${auth[@]}" "${URL}/api/tabs-sync/snapshots/${enc}" > "$snap_tmp"; then
      echo "ERROR: GET /snapshots/$d failed" >&2; rm -f "$snap_tmp"; _cleanup_fetch; return 1; fi
    if ! jq --arg d "$d" --slurpfile s "$snap_tmp" '. + {($d): $s[0]}' "$dev_tmp" > "${dev_tmp}.new"; then
      echo "ERROR: merge failed for device $d" >&2; rm -f "$snap_tmp"; _cleanup_fetch; return 1; fi
    mv "${dev_tmp}.new" "$dev_tmp"
    rm -f "$snap_tmp"
  done < <(jq -j '.devices[].deviceId | . + "\u0000"' "$snaps_tmp")
  # GET /api/terminals with NO read-model query params returns a RAW ARRAY
  # (terminals.rs:414); `.items` would be null. Keep the array as-is.
  if ! curl -fsS "${auth[@]}" "${URL}/api/terminals" > "$term_tmp"; then
    echo "ERROR: GET /api/terminals failed" >&2; _cleanup_fetch; return 1; fi
  jq -e 'type=="array"' "$term_tmp" >/dev/null \
    || { echo "ERROR: /terminals not an array" >&2; _cleanup_fetch; return 1; }
  # COHERENCE GATE (:40): re-fetch the index and compare the complete ordered
  # generation metadata. Digest multisets alone miss newest-per-client churn.
  if ! curl -fsS "${auth[@]}" "${URL}/api/tabs-sync/snapshots" > "$snaps2_tmp"; then
    echo "ERROR: coherence re-fetch of /api/tabs-sync/snapshots failed" >&2; _cleanup_fetch; return 1; fi
  local proj='[.devices[] | { deviceId, generations: [.generations[] | {
    generation, generationId, clientInstanceId, capturedAt, snapshotRevision
  }] }] | sort_by(.deviceId)'
  if [[ "$(jq -cS "$proj" "$snaps_tmp")" != "$(jq -cS "$proj" "$snaps2_tmp")" ]]; then
    echo "WARN: generation index changed mid-capture (concurrent tabs-sync push); capture incoherent" >&2
    _cleanup_fetch; return 3; fi
  # Assemble the capture doc INCLUDING the immutable per-device bundle: the exact
  # set of per-client component generation ids at capture (all clients), so
  # remediation restores the SAME coherent union, never a single client (:2621).
  # Both .devices and .bundles derive from the SAME pinned index snapshot.
  # Newest-per-client tie-break MIRRORS the server's `newest_per_client`
  # (crates/freshell-ws/src/tabs_persist.rs): higher capturedAt wins; an equal-
  # millisecond tie is broken by the greater filename, which for one client's
  # files (same encoded prefix) is exactly the greater zero-padded
  # snapshotRevision -- so max_by([capturedAt, snapshotRevision]) is the exact
  # mirror (:69), never max_by(capturedAt) alone.
  if ! jq -n --arg url "$URL" --slurpfile devices "$dev_tmp" --slurpfile terminals "$term_tmp" \
       --slurpfile snaps "$snaps_tmp" '
       { capturedAt: (now * 1000 | floor), url: $url,
         devices: $devices[0], terminals: $terminals[0],
         bundles: ($snaps[0].devices | map({ key: .deviceId, value: {
           components: (.generations | group_by(.clientInstanceId)
                        | map(max_by([.capturedAt, .snapshotRevision]) | .generationId)),
           capturedAt: (.capturedAt // 0) } }) | from_entries) }' > "$out_tmp"; then
    echo "ERROR: assembling capture JSON failed" >&2; _cleanup_fetch; return 1; fi
  cat "$out_tmp"
  _cleanup_fetch
}

# fetch_state with a bounded retry on the mid-capture-coherence failure (rc 3).
# Any other failure is immediate (rc 1).
fetch_state_coherent() {
  local attempt rc
  for attempt in 1 2 3; do
    rc=0; fetch_state || rc=$?
    [[ $rc -eq 3 ]] || return "$rc"
    echo "WARN: retrying capture (attempt $((attempt + 1))/3) after mid-capture change" >&2
  done
  echo "ERROR: generation index kept changing across 3 capture attempts; server too busy to capture coherently" >&2
  return 1
}

case "$CMD" in
  capture)
    [[ -n "$OUT" ]] || { echo "ERROR: capture requires --out FILE" >&2; exit 2; }
    # ATOMIC (:2544/:82): fetch into a TEMP file created IN THE DESTINATION
    # DIRECTORY (mktemp defaults to /tmp, which may be a different filesystem;
    # a cross-device mv is copy+unlink, NOT atomic), validate it parses + has
    # the expected shape, THEN rename over the final artifact -- a same-fs
    # rename is atomic. Any failure leaves a prior good $OUT UNTOUCHED and
    # exits nonzero.
    tmp_out=$(mktemp "$(dirname "$OUT")/.$(basename "$OUT").XXXXXX")
    if ! fetch_state_coherent > "$tmp_out"; then
      echo "ERROR: capture failed (server unreachable/invalid/incoherent); previous $OUT left UNTOUCHED" >&2
      rm -f "$tmp_out"; exit 1
    fi
    if ! jq -e '(.devices|type=="object") and (.terminals|type=="array") and (.capturedAt|type=="number")' \
         "$tmp_out" >/dev/null; then
      echo "ERROR: capture produced invalid/empty JSON; previous $OUT left UNTOUCHED" >&2
      rm -f "$tmp_out"; exit 1
    fi
    mv "$tmp_out" "$OUT"   # atomic rename over the final artifact
    ndev=$(jq '.devices | length' "$OUT")
    nrun=$(jq '[.terminals[] | select(.status=="running")] | length' "$OUT")
    echo "captured ${ndev} device snapshot(s), ${nrun} running terminal(s) -> $OUT"
    ;;
  verify)
    [[ -n "$BEFORE" && -f "$BEFORE" ]] || { echo "ERROR: verify requires --before FILE" >&2; exit 2; }
    # AFTER: synthetic (--after, offline diff-engine test) or live fetch.
    AFTER_OWNED=false
    if [[ -n "$AFTER_IN" ]]; then
      [[ -f "$AFTER_IN" ]] || { echo "ERROR: --after FILE not found" >&2; exit 2; }
      AFTER="$AFTER_IN"
    else
      AFTER=$(mktemp); AFTER_OWNED=true
      if ! fetch_state_coherent > "$AFTER"; then echo "ERROR: fetching AFTER state failed" >&2; rm -f "$AFTER"; exit 1; fi
    fi
    # Guard form (not `$AFTER_OWNED && rm`): with --after supplied AFTER_OWNED is
    # false, and a bare `false && ...` returns 1 -- under `set -e` that would kill
    # the OK path with exit 1 before its `exit 0`.
    cleanup() { if $AFTER_OWNED; then rm -f "$AFTER"; fi; }

    # Coverage guard (:2559): compute the COMPLETE set of running terminals at
    # capture that are covered by NO persisted snapshot pane, and FAIL listing them
    # if that set is nonempty. `. as $t | $covered | index($t)` binds the id to a
    # variable BEFORE indexing -- piping into `$covered` would otherwise rebind `.`
    # to the array and search it for ITSELF (the :2563 scoping bug).
    uncovered=$(jq -r '
      ([.terminals[] | select(.status=="running") | .terminalId]) as $live
      | ([.devices | to_entries[] | .value.records // [] | .[]
           | select(.status=="open") | .panes // [] | .[]
           | .payload.liveTerminal.terminalId | select(. != null)]) as $covered
      | [ $live[] | select(. as $t | ($covered | index($t)) == null) ] | .[]' "$BEFORE")
    if [[ -n "$uncovered" ]]; then
      n=$(printf '%s\n' "$uncovered" | grep -c .)
      echo "FAIL: ${n} running terminal(s) at capture are covered by NO persisted snapshot pane (tabs-sync persistence/coverage gap):" >&2
      printf '%s\n' "$uncovered" | sed 's/^/  - /' >&2
      cleanup; exit 1
    fi

    # Pane-by-pane identity diff. "live" == status=="running" (exited terminals
    # are filtered out so they never cause a false NOT RESPAWNED). A pane counts
    # only if it carried session identity OR was ACTUALLY running at capture.
    DIFF=$(jq -n --slurpfile b "$BEFORE" --slurpfile a "$AFTER" '
      # $dev/$snap are VALUE params (bound at the call site): plain filter params
      # are lazy closures re-evaluated against the CURRENT input, so `dev` (.key)
      # would evaluate against the pane object and yield null for every pane,
      # breaking the device column and the per-device remediation lookup.
      def panes($dev; $snap):
        ($snap.records // [])[] | select(.status == "open") as $rec
        | ($rec.panes // [])[]
        | {device: $dev, tabKey: $rec.tabKey, tabName: $rec.tabName, paneId: .paneId,
           kind: .kind, sessionRef: .payload.sessionRef,
           liveTerminalId: .payload.liveTerminal.terminalId};
      ($b[0].terminals | map(select(.status=="running") | .terminalId)) as $liveBefore
      | ($a[0].terminals | map(select(.status=="running") | .terminalId)) as $liveNow
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
      cleanup; exit 0
    fi
    echo "================ TAB-DIFF DIVERGENCE (${COUNT}) ================"
    jq -r '.[] | "\(.verdict)\tdevice=\(.pane.device)\ttab=\(.pane.tabName) (\(.pane.tabKey))\tpane=\(.pane.paneId)\tkind=\(.pane.kind)\twas=\(.pane.sessionRef.provider // "-"):\(.pane.sessionRef.sessionId // "-")\(if .after then "\tnow=\(.after.provider):\(.after.sessionId)" else "" end)"' <<<"$DIFF"
    echo "================================================================"
    # Remediation is TARGETED (:175): it restores ONLY the diverged panes (one
    # --pane per diverged paneKey, the restore API's selective mode) from the
    # IMMUTABLE multi-client BUNDLE recorded in the BEFORE capture (the exact
    # set of per-client component generation ids at capture), via --components
    # -- the SAME coherent union the capture saw, NEVER a single client's
    # generationId (:2621), and never the WHOLE union (which would duplicate
    # every still-healthy pane). Everything is read from the BEFORE file +
    # $DIFF, so verify performs ZERO network operations in --after/offline
    # mode (:2619).
    echo "REMEDIATION (rebuild each diverged device's MISSING panes from its captured immutable bundle):"
    while IFS= read -r -d '' dev; do
      comps=$(jq -r --arg d "$dev" '(.bundles[$d].components // []) | join(",")' "$BEFORE")
      if [[ -z "$comps" ]]; then
        printf 'ERROR: no captured bundle for device %q in the before-file; cannot recommend a union-consistent restore.\n' "$dev" >&2
        continue
      fi
      pane_args=""
      while IFS= read -r -d '' pk; do
        pane_args+=$(printf ' --pane %q' "$pk")
      done < <(jq -j --arg d "$dev" \
        '[.[] | select(.pane.device == $d) | "\(.pane.tabKey)#\(.pane.paneId)"] | unique | .[] | . + "\u0000"' \
        <<<"$DIFF")
      printf '  scripts/restore-tabs.sh --url %q --token <TOKEN> --device %q --components %s --force%s\n' \
        "$URL" "$dev" "$comps" "$pane_args"
    done < <(jq -j '[.[].pane.device] | unique | .[] | . + "\u0000"' <<<"$DIFF")
    cleanup; exit 1
    ;;
  *)
    echo "usage: deploy-tab-diff.sh {capture|verify} --url U --token T [--out F | --before F [--after F]]" >&2
    exit 2 ;;
esac
```

- [x] **Step 2: Syntax + lint check (ENFORCING — no `|| true`)**

Run (both scripts; the `&&` chain fails the step if EITHER `bash -n` or ShellCheck fails):
```bash
bash -n scripts/deploy-tab-diff.sh && bash -n scripts/restore-tabs.sh \
  && shellcheck scripts/deploy-tab-diff.sh scripts/restore-tabs.sh
```
Expected: PASS (exit 0). Fix every real bug ShellCheck reports; for a deliberately-accepted style-only finding, silence it with an inline `# shellcheck disable=SCXXXX` + a one-line justification rather than masking the whole gate with `|| true` (which would let a genuine `bash -n`/ShellCheck failure pass as green).

- [x] **Step 3: Commit**

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
- Consumes: everything above; fake-codex wiring copied from `codex-terminal-bounce-rust.spec.ts` (EPHEMERAL server via `new RustServer(...)`, per Global Constraints — never `createE2eServerHandle`). The fake-codex `FAKE_CODEX_ARGV_LOG` is the post-remediation resume proof.
- Produces: committed acceptance for deliverable 3, in TWO tests: (1) a LIVE capture→restart→verify (OK) then identity-loss (MISSING) → loud fail → executed `--components` bundle remediation proven by the fake-CLI argv resume log; and (2) a DETERMINISTIC, FULLY OFFLINE diff-engine test (a fake `curl` aborts if the script makes any network call, `:2619`) driving `verify --before F --after F` over synthetic fixtures to exercise the `MISSING` / `FRESH (identity lost)` / `RE-POINTED` / `NOT RESPAWNED` verdicts, the PARTIAL-coverage set-difference guard (`:2559`), and the MULTI-CLIENT bundle remediation (`:2621`) — categories the live MISSING-only path cannot produce.

- [x] **Step 1: Write the live acceptance spec**

```ts
import { test, expect } from '../helpers/fixtures.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'

const run = promisify(execFile)
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

// Fake-CLI argv resume proof (copied from codex-terminal-bounce-rust.spec.ts:75-85).
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[] })
}
function hasResumePair(argv: string[], sessionId: string): boolean {
  const idx = argv.indexOf('resume')
  return idx >= 0 && argv[idx + 1] === sessionId
}

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
    // EPHEMERAL-ONLY: new RustServer(...) directly (never createE2eServerHandle).
    const argLogPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'fakecodex-')), 'argv.jsonl')
    const server = new RustServer({
      env: { /* CODEX_CMD=<fake codex> + FAKE_CODEX_ARGV_LOG=argLogPath, copied from codex-terminal-bounce-rust.spec.ts */ },
      setupHome: async (homeDir) => { /* config seeding copied from the same spec */ },
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
      expect(bad.out).toMatch(/MISSING/)                             // names the category (closed codex pane)
      expect(bad.out).toContain('scripts/restore-tabs.sh')           // prints the remediation
      // Remediation references the immutable multi-client BUNDLE (--components,
      // stable digests), NEVER a single-client --generation-id (:2621).
      expect(bad.out).toMatch(/--components [0-9a-f,]+/)
      expect(bad.out).not.toMatch(/--generation-id/)
      expect(bad.out).not.toMatch(/--generation \d/)

      // -- EXECUTE the printed remediation (substituting the real token) and prove
      //    the missing codex session comes back. Only 1 browser connected -> the
      //    restore exactly-one-client gate allows it. --
      const comps = bad.out.match(/--components ([0-9a-f,]+)/)![1]
      const dev = bad.out.match(/--device (\S+)/)![1]
      const argvBefore = (await readArgvLog(argLogPath)).length
      const rem = await run('scripts/restore-tabs.sh',
        ['--url', info.baseUrl, '--token', info.token, '--device', dev, '--components', comps],
        { cwd: process.cwd() })
      expect(rem.stdout).toContain('failed=0')
      await expect(async () => {
        expect(await codexPaneSession(harness)).toBe(SESSION_ID)      // the session identity returned
      }).toPass({ timeout: 20_000 })
      // RESUME PROOF: the remediation re-spawned codex with `resume <sessionId>`
      // (argv-log delta), not plain `codex` -- identity echo alone is insufficient.
      await expect(async () => {
        const entries = (await readArgvLog(argLogPath)).slice(argvBefore)
        expect(entries.some((e) => hasResumePair(e.argv, SESSION_ID)),
          'remediation must exec `codex resume <sessionId>`').toBe(true)
      }).toPass({ timeout: 20_000 })
    } finally {
      await server.stop()
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  // (2) DETERMINISTIC OFFLINE diff-engine coverage: drive `verify --before F
  // --after F` over synthetic fixtures so ALL FOUR verdicts, the full-set-difference
  // coverage guard, and the multi-client bundle remediation are exercised (the live
  // path can only produce MISSING). With --after supplied verify does ZERO network
  // ops (:2619) -- proven by prepending a fake `curl` that ABORTS if invoked.
  test('verify classifies verdicts, guards partial coverage, remediates via bundle -- fully offline', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-unit-'))
    // A fake `curl` that aborts (exit 99) on ANY invocation -- the offline guard.
    const binDir = path.join(tmp, 'bin'); await fs.mkdir(binDir)
    await fs.writeFile(path.join(binDir, 'curl'),
      '#!/usr/bin/env bash\necho "NETWORK CALL (curl) during offline verify" >&2\nexit 99\n', { mode: 0o755 })
    const runOffline = async (args: string[]) => {
      try {
        const { stdout, stderr } = await run('scripts/deploy-tab-diff.sh', args,
          { cwd: process.cwd(), env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } })
        return { code: 0, out: `${stdout}${stderr}` }
      } catch (err: any) {
        return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
      }
    }
    const write = async (name: string, doc: unknown) => {
      const p = path.join(tmp, name); await fs.writeFile(p, JSON.stringify(doc)); return p
    }
    const term = (id: string, status: string) => ({ terminalId: id, status })
    const pane = (kind: string, extra: any) => ({ paneId: `p-${kind}`, kind, payload: extra })
    const rec = (tabKey: string, panes: any[]) =>
      ({ tabKey, tabId: tabKey, tabName: tabKey, status: 'open', revision: 1, updatedAt: 1, paneCount: panes.length, panes })
    // `bundles` carries the immutable per-device component ids (two clients here).
    const doc = (capturedAt: number, records: any[], terminals: any[], bundles: any = {}) =>
      ({ capturedAt, url: 'http://unused.invalid', devices: { 'dev-1': { deviceId: 'dev-1', records } }, terminals, bundles })

    const before = await write('before.json', doc(1000, [
      rec('dev-1:codexMiss', [pane('terminal', { mode: 'codex', sessionRef: { provider: 'codex', sessionId: 'S-miss' } })]),
      rec('dev-1:codexRepoint', [pane('terminal', { mode: 'codex', sessionRef: { provider: 'codex', sessionId: 'S-old' } })]),
      rec('dev-1:codexFresh', [pane('terminal', { mode: 'codex', sessionRef: { provider: 'codex', sessionId: 'S-fresh' } })]),
      rec('dev-1:sh', [pane('terminal', { mode: 'shell', liveTerminal: { terminalId: 'T-live' } })]),
    ], [term('T-live', 'running'), term('T-exited', 'exited')],
    { 'dev-1': { components: ['aaaa1111', 'bbbb2222'], capturedAt: 1000 } })) // TWO-client bundle
    const after = await write('after.json', doc(2000, [
      rec('dev-1:codexRepoint', [pane('terminal', { mode: 'codex', sessionRef: { provider: 'codex', sessionId: 'S-new' } })]),
      rec('dev-1:codexFresh', [pane('terminal', { mode: 'codex' })]),
      rec('dev-1:sh', [pane('terminal', { mode: 'shell', liveTerminal: { terminalId: 'T-gone' } })]),
    ], []))
    const d = await runOffline(['verify', '--url', 'http://unused.invalid', '--token', 't', '--before', before, '--after', after])
    expect(d.code).not.toBe(0)
    expect(d.code).not.toBe(99)                       // curl was NEVER called (:2619)
    expect(d.out).not.toContain('NETWORK CALL')
    expect(d.out).toContain('MISSING')
    expect(d.out).toContain('RE-POINTED')
    expect(d.out).toContain('FRESH (identity lost)')
    expect(d.out).toContain('NOT RESPAWNED')
    // Remediation uses the immutable MULTI-CLIENT bundle (BOTH component ids), not
    // a single-client --generation-id (:2621).
    expect(d.out).toMatch(/--components aaaa1111,bbbb2222/)
    expect(d.out).not.toMatch(/--generation-id/)

    // PARTIAL-coverage guard (:2559): TWO running terminals, only ONE covered by a
    // snapshot pane -> still FAILS, LISTING the uncovered one (not a silent OK).
    const beforePartial = await write('partial.json', doc(1000, [
      rec('dev-1:sh', [pane('terminal', { mode: 'shell', liveTerminal: { terminalId: 'T-covered' } })]),
    ], [term('T-covered', 'running'), term('T-uncovered', 'running')]))
    const afterPartial = await write('partialafter.json', doc(2000, [], []))
    const g = await runOffline(['verify', '--url', 'http://unused.invalid', '--token', 't', '--before', beforePartial, '--after', afterPartial])
    expect(g.code).not.toBe(0)
    expect(g.code).not.toBe(99)
    expect(g.out).toMatch(/coverage gap/i)
    expect(g.out).toContain('T-uncovered')            // names the uncovered terminal
    expect(g.out).not.toContain('T-covered')          // the covered one is NOT flagged
    await fs.rm(tmp, { recursive: true, force: true })
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

- [x] **Step 2: Register the spec — BOTH the `rust-chromium` `testMatch` AND the shared `RUST_ONLY_SPECS` testIgnore list**

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

- [x] **Step 3: Run twice**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium deploy-tab-diff-rust.spec.ts --repeat-each=2`
Expected: 2 passed.

- [x] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): deploy tab-diff ritual acceptance -- OK across a clean restart, loud red on identity loss

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

## Final verification (whole system, before handing to review)

- [x] `cargo test -p freshell-ws -p freshell-server -p freshell-freshagent -p freshell-terminal` — green
- [x] `cargo clippy --workspace` + `cargo fmt --all -- --check` — clean on touched files
- [x] `npm run test:status`, then `npm run test:vitest -- test/e2e-browser/vitest.config.ts` equivalent for helper tests if helpers changed (`npm run test:e2e:helpers`)
- [x] `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium snapshot-restore-rust.spec.ts deploy-tab-diff-rust.spec.ts codex-terminal-bounce-rust.spec.ts remote-tab-linkage-rust.spec.ts restore-matrix.spec.ts` — green (no regression in the neighboring identity specs)
- [x] `npm run smoke:continuity` — green, ≤5 min (the single budget shared by the Goal + `test.setTimeout(300_000)`)
- [x] `git log --oneline 136b9e94..HEAD` shows the three deliverables as ordered, focused series
- [x] `git diff 136b9e94..HEAD --stat -- server/ shared/ src/ dist/` is EMPTY (frozen paths untouched)

## Self-review record (spec vs plan)

1. **Spec coverage:** D1 persists sessionRef in a focused `tabs_persist` module; all snapshot-directory mutation is serialized; retention is bounded; generation files and marker documents are semantically validated; generation and marker writes fsync the temp file and parent directory; `snapshot_content_id` identifies logical restore content while the full-document `snapshot_generation_id` immutably identifies each file; exact component bundles cannot be displaced by later equal-content files. Restore drives the real create pipeline in deferred mode, sends only to one selected connection, accepts acknowledgements only from that id, strictly parses control flags, performs marker-aware dry runs, and bounds the marker-source ledger. Requested shell type is resolved by the platform spawn matrix. D2's real-CLI smoke uses the formats/auth/trust/picker behavior proven by the probes. D3's atomic capture coherence fence compares complete ordered generation metadata, and its offline test catches same-digest client/order churn. No `port/oracle/DEVIATIONS.md` entry is required because the surface is additive.
2. **Deferral audit (1b):** one intentional, LOUD limitation: restore recreates `terminal`/`browser`/`editor` panes and reports `fresh-agent` panes as `skipped: unsupported-kind` (the REST pipeline has no agent-resume shape — `lib.rs:1158-1171`), surfaced in the response, the operator script, and the module docs — not silent. A terminal pane whose captured `sessionRef` is present-but-invalid (not an object, empty/missing `sessionId`, or `provider != mode`) is reported `failed: session-identity-mismatch` (never spawned as a fresh session labelled "restored"). No requirement was moved to "future work".
3. **Placeholder scan:** remaining `<...>` tokens are run-time values (uuids, shas, captured output) or explicit mirror-this-file instructions pointing at a named existing spec/block — no TBD/TODO steps.
4. **Type consistency:** `tabs_persist::{with_persist_dir(on TabsRegistry)/list_generations(3-arg)/read_generation/read_generation_by_id/read_generations_union_by_ids/read_device_union/read_device_overview/list_snapshot_devices/encode_device_id/snapshot_content_id/persist_generation/MAX_SNAPSHOT_{GENERATIONS,FILES_PER_DEVICE,DEVICES,BYTES}}` names match across Tasks 1-3 (all readers return `io::Result`); `TabsSnapshotsState{auth_token, snapshots_dir, fresh_agent, screenshots, terminals, restore_lock, restore_ack_timeout}` matches Tasks 2-3 and the `main.rs` merge; the create envelope `{status,data,message}` `.data` unwrap is used uniformly (Tasks 3,5,10); the restore body selector priority `components > generationId > generation > union` is identical in the handler, `restore-tabs.sh` (`--components`/`--generation-id`/`--generation`), and the Task 9 `--components` remediation executed in Task 10; the deploy `bundles[deviceId].components` shape matches the restore `components` field; the deploy script's `--after` (offline) matches Task 10's fake-curl offline test; `RUST_ONLY_SPECS` testIgnore spans Tasks 5/7/10; new specs construct `new RustServer(...)` (ephemeral-only); `FRESHELL_E2E_RUST_SERVER_BIN` + `resolveRustServerBin`/`rustServerBinSha256` (fail-closed, self-tested) match Tasks 6 and 8.
