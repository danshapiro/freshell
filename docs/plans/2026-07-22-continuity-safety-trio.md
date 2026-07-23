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
- `POST /api/tabs` (the proven create pipeline): `crates/freshell-freshagent/src/lib.rs:1150-1163` (`create_tab`; `agent` absent → `terminal_tabs::create_terminal_or_content_tab`); terminal path `crates/freshell-freshagent/src/terminal_tabs.rs:183-224,952-1046` — body keys `mode`, `cwd`, `name`, `sessionRef` (honored when `sessionRef.provider == mode`), `resumeSessionId` (legacy; rejected for codex), `browser: <url>`, `editor: <filePath>`; response `{tabId, paneId, terminalId}` (terminal) / `{tabId, paneId}` (content); broadcasts `ui.command{tab.create}` which connected clients fold into Redux.
- REST auth: `x-auth-token` header (or `freshell-auth` cookie) — `crates/freshell-server/src/boot.rs:686-698`.
- Live terminal registry REST: `GET /api/terminals` (`crates/freshell-server/src/terminals.rs:103,395-530`) → `{items, nextCursor, revision}`; each item: `terminalId`, `title`, `mode`, `sessionRef?`, `createdAt`, `lastActivityAt`, `status`, `hasClients`, `cwd?`, `lastLine`. Also `GET /api/terminals/{id}/search?q=...` searches the server-side scrollback mirror (`terminals.rs:108,382-392`) — the strongest offline assertion that a CLI actually rendered text into a pane.
- Router assembly: `crates/freshell-server/src/main.rs:620-663` (`.merge(...)` chain) — new routers merge there.
- E2e harness: `test/e2e-browser/helpers/rust-server.ts` — `RustServer` builds/locates the release `freshell-server` binary (`ensureRustServerBuilt`), boots on an ephemeral loopback port with a unique token and isolated `FRESHELL_HOME` (mkdtemp), options `{homeDir?, token?, env?, setupHome?, preserveHomeOnStop?, verbose?}`, plus `restart()` (same home/port/token — the browser WS auto-reconnects). `TestServerInfo` = `{port, baseUrl, wsUrl, token, configDir, homeDir, ...}` (`helpers/test-server.ts:14-25`). `helpers/test-harness.ts` exposes `bootAndConnect(page, info)`, `harness.getTabCount()`, `harness.getActiveTabId()`, `harness.getState()`.
- Playwright projects: `test/e2e-browser/playwright.config.ts:95-170` — `chromium` (no `testMatch` → matches everything), `legacy-chromium`/`rust-chromium` with explicit `testMatch` lists (rust-only specs are appended to `rust-chromium`'s list with a doc comment each).
- Session fixture formats already used in-repo (mirror these):
  - codex: `<home>/.codex/sessions/YYYY/MM/DD/rollout-<ISO-with-dashes>-<uuid>.jsonl`, lines `{timestamp, type:'session_meta', payload:{id, cwd}}` then `{type:'response_item', payload:{type:'message', role, content:[{type:'input_text'|'output_text', text}]}}` (`test/e2e-browser/specs/sidebar-click-resume.spec.ts:175-208`; real codex nests under `sessions/YYYY/MM/DD/`, `crates/freshell-sessions/src/directory_index.rs:327-333,412-413`).
  - amplifier: `<home>/.amplifier/projects/<slug>/sessions/<id>/metadata.json` (`{session_id, working_dir, created, name, description}`) + sibling `transcript.jsonl` (`sidebar-click-resume.spec.ts:325-350`; `crates/freshell-sessions/src/amplifier.rs:1-57`).
  - claude: `<home>/.claude/projects/<munged-cwd>/<sessionId>.jsonl` (cwd path separators → `-`; `crates/freshell-sessions/src/directory_index.rs:154-205`). Claude session ids must be canonical UUIDs (`terminal_tabs.rs:162-166`).
- The historical bug for the Deliverable 2 proof: at `136b9e94~1` the WS `terminal.create` codex arm read ONLY `resumeSessionId` and ignored `sessionRef`, so every codex open/restore spawned plain `codex` with no resume args (see `git show 136b9e94`). A codex leg that asserts seeded-history visibility MUST fail there and pass at HEAD.
- Real CLIs on this host: `codex` (codex-cli 0.145.0), `amplifier` (`~/.local/bin/amplifier`), `claude` (2.1.218), `jq` at `/usr/bin/jq`.

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
- Consumes: existing `TabsRegistry::replace_client_snapshot` (`tabs.rs:107`).
- Produces (later tasks rely on these exact names):
  - `TabsRegistry::with_persist_dir(dir: std::path::PathBuf) -> TabsRegistry`
  - `pub const MAX_SNAPSHOT_GENERATIONS: usize = 5;`
  - `pub fn sanitize_device_id(device_id: &str) -> String`
  - `pub fn list_snapshot_devices(dir: &std::path::Path) -> Vec<String>` (sanitized dir names)
  - `pub fn list_generations(dir: &std::path::Path, device_id: &str) -> Vec<std::path::PathBuf>` (newest first)
  - `pub fn read_generation(dir: &std::path::Path, device_id: &str, generation: usize) -> Option<serde_json::Value>` (0 = newest)
  - Generation file JSON: `{deviceId, deviceLabel, clientInstanceId, serverInstanceId, snapshotRevision, capturedAt, records: [...open records, verbatim, post-identity-stamping]}`
  - Filename: `format!("{:020}-r{}.json", captured_at_ms, snapshot_revision)` (zero-padded → lexicographic == chronological)

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `crates/freshell-ws/src/tabs.rs`:

```rust
#[test]
fn persisted_generation_written_with_session_ref_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    let mut rec = open_record("dev-a:tab-1", "My codex tab", 1000);
    rec["panes"] = json!([{
        "paneId": "pane-1",
        "kind": "terminal",
        "payload": {
            "mode": "codex",
            "sessionRef": { "provider": "codex", "sessionId": "abc-123" },
            "initialCwd": "/tmp/proj",
            "liveTerminal": { "terminalId": "term-1", "serverInstanceId": "srv-1" }
        }
    }]);
    reg.replace_client_snapshot("srv-1", "dev a/1", "Device A", "client-a1", 1, vec![rec])
        .unwrap();

    let gens = list_generations(dir.path(), "dev a/1");
    assert_eq!(gens.len(), 1);
    let snap = read_generation(dir.path(), "dev a/1", 0).expect("newest generation");
    assert_eq!(snap["deviceId"], "dev a/1");
    assert_eq!(snap["snapshotRevision"], 1);
    assert_eq!(
        snap["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"],
        "abc-123"
    );
    // Identity stamping (envelope wins) must be visible in the persisted record too.
    assert_eq!(snap["records"][0]["deviceId"], "dev a/1");
}

#[test]
fn generations_pruned_to_max_and_ordered_newest_first() {
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    for rev in 1..=(MAX_SNAPSHOT_GENERATIONS as i64 + 2) {
        reg.replace_client_snapshot(
            "srv-1", "dev", "Dev", "c1", rev,
            vec![open_record("dev:t1", &format!("rev {rev}"), 1000 + rev)],
        )
        .unwrap();
    }
    let gens = list_generations(dir.path(), "dev");
    assert_eq!(gens.len(), MAX_SNAPSHOT_GENERATIONS);
    let newest = read_generation(dir.path(), "dev", 0).unwrap();
    assert_eq!(newest["snapshotRevision"], MAX_SNAPSHOT_GENERATIONS as i64 + 2);
    let oldest = read_generation(dir.path(), "dev", MAX_SNAPSHOT_GENERATIONS - 1).unwrap();
    assert_eq!(oldest["snapshotRevision"], 3); // revisions 1 and 2 pruned
}

#[test]
fn empty_snapshot_does_not_overwrite_last_good_generation() {
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    reg.replace_client_snapshot("srv-1", "dev", "Dev", "c1", 1,
        vec![open_record("dev:t1", "good", 1000)]).unwrap();
    // A wipe/unload push with zero open records must NOT mint a generation:
    // the newest generation stays the last-good one (restore-after-wipe semantics).
    reg.replace_client_snapshot("srv-1", "dev", "Dev", "c1", 2, vec![]).unwrap();
    let gens = list_generations(dir.path(), "dev");
    assert_eq!(gens.len(), 1);
    assert_eq!(read_generation(dir.path(), "dev", 0).unwrap()["snapshotRevision"], 1);
}

#[test]
fn stale_revision_persists_nothing_and_registry_without_dir_persists_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    reg.replace_client_snapshot("srv-1", "dev", "Dev", "c1", 5,
        vec![open_record("dev:t1", "one", 10)]).unwrap();
    assert!(reg.replace_client_snapshot("srv-1", "dev", "Dev", "c1", 4, vec![]).is_err());
    assert_eq!(list_generations(dir.path(), "dev").len(), 1);

    let plain = TabsRegistry::new();
    plain.replace_client_snapshot("srv-1", "dev", "Dev", "c1", 1,
        vec![open_record("dev:t1", "one", 10)]).unwrap();
    // No persist dir → no files anywhere; just proves the Option path compiles/runs.
}

#[test]
fn sanitize_device_id_is_filesystem_safe_and_stable() {
    assert_eq!(sanitize_device_id("dev a/1"), "dev_a_1");
    assert_eq!(sanitize_device_id("simple-id_9.x"), "simple-id_9.x");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-ws persisted_generation` (from the worktree root)
Expected: FAIL to compile — `with_persist_dir`, `list_generations`, `read_generation`, `sanitize_device_id`, `MAX_SNAPSHOT_GENERATIONS` not defined. (If `tempfile` is missing from `freshell-ws`'s dev-dependencies, add `tempfile = "3"` — check `crates/freshell-terminal/Cargo.toml` for the workspace-consistent form first.)

- [ ] **Step 3: Implement persistence**

In `crates/freshell-ws/src/tabs.rs`:

```rust
use std::path::{Path, PathBuf};

/// Maximum snapshot generations retained per device (oldest pruned).
pub const MAX_SNAPSHOT_GENERATIONS: usize = 5;

/// Filesystem-safe device directory name: every char outside
/// `[A-Za-z0-9._-]` becomes `_`. Deterministic and collision-tolerant
/// (a collision only merges two devices' generation FOLDERS, never corrupts
/// a file; device ids are uuid-like in practice).
pub fn sanitize_device_id(device_id: &str) -> String {
    device_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

/// Devices that have at least one persisted generation (sanitized dir names).
pub fn list_snapshot_devices(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new(); };
    let mut out: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    out.sort();
    out
}

/// Generation files for a device, newest first (filenames are zero-padded
/// capture timestamps, so lexicographic descending == chronological descending).
pub fn list_generations(dir: &Path, device_id: &str) -> Vec<PathBuf> {
    let device_dir = dir.join(sanitize_device_id(device_id));
    let Ok(entries) = std::fs::read_dir(&device_dir) else { return Vec::new(); };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    files.reverse();
    files
}

/// Read the Nth-newest generation (0 = newest). None when out of range/unreadable.
pub fn read_generation(dir: &Path, device_id: &str, generation: usize) -> Option<Value> {
    let files = list_generations(dir, device_id);
    let path = files.get(generation)?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}
```

Add the field + constructor on `TabsRegistry` (the struct currently derives
`Clone, Default` over just `inner` — keep `Default` by making the dir an
`Option`):

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

At the END of `replace_client_snapshot` (after the state mutations, just
before `Ok(PushAck { ... })` — i.e. only on ACCEPTED, non-idempotent pushes;
note the idempotent same-revision early-return at `tabs.rs:152-162` returns
before this point, which is correct), add:

```rust
        // Persist a snapshot generation (best-effort; never fails the push).
        // Skip empty snapshots: a wipe/unload push must not overwrite the
        // last-good generation this feature exists to restore from.
        if let Some(dir) = &self.persist_dir {
            if !open_records.is_empty() {
                self.persist_generation(
                    dir, server_instance_id, device_id, device_label,
                    client_instance_id, snapshot_revision, &open_records, now,
                );
            }
        }
```

(The `open_records` binding computed at `tabs.rs:129-133` is already the
post-stamping open set — move the persist call after the lock is released or
pass what it needs; the lock guard `state` drops at the end of the block, so
place this after `state.client_revisions.insert(...)`/`state.devices.insert(...)`
but it does not need the lock at all.)

```rust
    /// Write `<dir>/<sanitized-device>/<zero-padded-ms>-r<rev>.json` atomically
    /// (tmp + rename) and prune the device dir to MAX_SNAPSHOT_GENERATIONS.
    /// Best-effort: any IO error is a WARN, never an Err (the in-memory
    /// registry remains the wire-visible source of truth).
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
        let device_dir = dir.join(sanitize_device_id(device_id));
        let write = || -> std::io::Result<()> {
            std::fs::create_dir_all(&device_dir)?;
            let snapshot = json!({
                "deviceId": device_id,
                "deviceLabel": device_label,
                "clientInstanceId": client_instance_id,
                "serverInstanceId": server_instance_id,
                "snapshotRevision": snapshot_revision,
                "capturedAt": captured_at,
                "records": open_records,
            });
            let name = format!("{captured_at:020}-r{snapshot_revision}.json");
            let tmp = device_dir.join(format!(".{name}.tmp"));
            std::fs::write(&tmp, serde_json::to_vec_pretty(&snapshot)?)?;
            std::fs::rename(&tmp, device_dir.join(&name))?;
            // Prune: keep the newest MAX_SNAPSHOT_GENERATIONS files.
            let mut files: Vec<PathBuf> = std::fs::read_dir(&device_dir)?
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| e == "json"))
                .collect();
            files.sort();
            while files.len() > MAX_SNAPSHOT_GENERATIONS {
                let victim = files.remove(0);
                let _ = std::fs::remove_file(victim);
            }
            Ok(())
        };
        if let Err(err) = write() {
            tracing::warn!(
                target: "freshell_ws::tabs",
                device_id = %device_id,
                error = %err,
                "tabs_snapshot_persist_failed: generation not written"
            );
        }
    }
```

(If `tracing` is not already a dependency of `freshell-ws`, it is — `terminal.rs` uses `tracing::warn!`.)

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
- Consumes: `freshell_ws::tabs::{list_snapshot_devices, list_generations, read_generation, sanitize_device_id}` (Task 1); `boot.rs`-style auth (`x-auth-token`).
- Produces:
  - `GET /api/tabs-sync/snapshots` → `{"devices":[{"deviceId":"<sanitized>","generations":[{"generation":0,"capturedAt":...,"snapshotRevision":...,"recordCount":...,"deviceLabel":"..."}]}]}` (generations newest-first)
  - `GET /api/tabs-sync/snapshots/{deviceId}?generation=N` → the full generation JSON from Task 1 (default `generation=0`; 404 when absent)
  - `pub struct TabsSnapshotsState { pub auth_token: std::sync::Arc<String>, pub snapshots_dir: Option<std::path::PathBuf>, pub fresh_agent: freshell_freshagent::FreshAgentState }` — `fresh_agent` is used by Task 3's restore handler; construct it now so the router is built once.
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

    fn seed_generation(dir: &std::path::Path, device: &str, name: &str, snapshot: serde_json::Value) {
        let ddir = dir.join(device);
        std::fs::create_dir_all(&ddir).unwrap();
        std::fs::write(ddir.join(name), serde_json::to_vec(&snapshot).unwrap()).unwrap();
    }

    fn snapshot(rev: i64, session_id: &str) -> serde_json::Value {
        json!({
            "deviceId": "dev-1", "deviceLabel": "Dev One", "clientInstanceId": "c1",
            "serverInstanceId": "srv", "snapshotRevision": rev, "capturedAt": 1000 + rev,
            "records": [{
                "tabKey": "dev-1:tab-1", "tabId": "tab-1", "tabName": "codex",
                "status": "open", "revision": rev, "updatedAt": 1000 + rev, "paneCount": 1,
                "panes": [{ "paneId": "p1", "kind": "terminal", "payload": {
                    "mode": "codex",
                    "sessionRef": { "provider": "codex", "sessionId": session_id },
                    "initialCwd": "/tmp"
                }}]
            }]
        })
    }

    async fn get(router: axum::Router, uri: &str, auth: bool) -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder().method("GET").uri(uri);
        if auth { req = req.header("x-auth-token", TOKEN); }
        let resp = router.oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, body)
    }

    fn test_state(dir: &std::path::Path) -> TabsSnapshotsState {
        TabsSnapshotsState {
            auth_token: std::sync::Arc::new(TOKEN.to_string()),
            snapshots_dir: Some(dir.to_path_buf()),
            fresh_agent: freshell_freshagent::FreshAgentState::new_for_tests(TOKEN),
        }
    }

    #[tokio::test]
    async fn snapshots_list_requires_auth_and_lists_devices_with_generations() {
        let dir = tempfile::tempdir().unwrap();
        seed_generation(dir.path(), "dev-1", "00000000000000001001-r1.json", snapshot(1, "s-old"));
        seed_generation(dir.path(), "dev-1", "00000000000000001002-r2.json", snapshot(2, "s-new"));
        let (status, _) = get(router(test_state(dir.path())), "/api/tabs-sync/snapshots", false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, body) = get(router(test_state(dir.path())), "/api/tabs-sync/snapshots", true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["devices"][0]["deviceId"], "dev-1");
        let gens = body["devices"][0]["generations"].as_array().unwrap();
        assert_eq!(gens.len(), 2);
        assert_eq!(gens[0]["generation"], 0);
        assert_eq!(gens[0]["snapshotRevision"], 2); // newest first
        assert_eq!(gens[0]["recordCount"], 1);
    }

    #[tokio::test]
    async fn snapshot_fetch_newest_and_nth_and_404() {
        let dir = tempfile::tempdir().unwrap();
        seed_generation(dir.path(), "dev-1", "00000000000000001001-r1.json", snapshot(1, "s-old"));
        seed_generation(dir.path(), "dev-1", "00000000000000001002-r2.json", snapshot(2, "s-new"));
        let (status, body) =
            get(router(test_state(dir.path())), "/api/tabs-sync/snapshots/dev-1", true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"], "s-new");
        let (_, body) =
            get(router(test_state(dir.path())), "/api/tabs-sync/snapshots/dev-1?generation=1", true).await;
        assert_eq!(body["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"], "s-old");
        let (status, _) =
            get(router(test_state(dir.path())), "/api/tabs-sync/snapshots/nope", true).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
```

`FreshAgentState::new_for_tests` may not exist — check how `terminal_tabs.rs`'s own tests construct a state (`terminal_tabs.rs:1390-1410`, `fn app(state: FreshAgentState)`); reuse that constructor (it is in-crate, so if it's `pub(crate)`-only, add a small `pub fn new_for_tests(token: &str) -> Self` to `freshell-freshagent/src/lib.rs` mirroring it — needed anyway by Task 3's tests).

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

use crate::boot_auth::is_authed; // see note below

#[derive(Clone)]
pub struct TabsSnapshotsState {
    pub auth_token: Arc<String>,
    pub snapshots_dir: Option<PathBuf>,
    pub fresh_agent: freshell_freshagent::FreshAgentState,
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
            let generations: Vec<Value> = freshell_ws::tabs::list_generations(dir, &device)
                .iter()
                .enumerate()
                .filter_map(|(n, path)| {
                    let text = std::fs::read_to_string(path).ok()?;
                    let snap: Value = serde_json::from_str(&text).ok()?;
                    Some(json!({
                        "generation": n,
                        "capturedAt": snap.get("capturedAt").cloned().unwrap_or(Value::Null),
                        "snapshotRevision": snap.get("snapshotRevision").cloned().unwrap_or(Value::Null),
                        "deviceLabel": snap.get("deviceLabel").cloned().unwrap_or(Value::Null),
                        "recordCount": snap.get("records").and_then(Value::as_array).map(|r| r.len()).unwrap_or(0),
                    }))
                })
                .collect();
            json!({ "deviceId": device, "generations": generations })
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
    let generation: usize = params
        .iter()
        .find(|(k, _)| k == "generation")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let snap = state
        .snapshots_dir
        .as_deref()
        .and_then(|dir| freshell_ws::tabs::read_generation(dir, &device_id, generation));
    match snap {
        Some(snap) => Json(snap).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "Snapshot not found" }))).into_response(),
    }
}
```

**Auth note:** `is_authed` lives in `boot.rs` as `pub(crate)` (`boot.rs:686`) —
import it as `use crate::boot::is_authed;` (both modules are in the same
crate; if `boot`'s items aren't reachable, raise its visibility to
`pub(crate)` — do NOT copy the function).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server tabs_snapshots`
Expected: PASS.

- [ ] **Step 5: Merge the router in `main.rs`**

In the `.merge(...)` chain (`main.rs:620-663`), after `boot::router(...)`:

```rust
        .merge(tabs_snapshots::router(tabs_snapshots::TabsSnapshotsState {
            auth_token: auth_token.clone(),
            snapshots_dir: home.as_ref().map(|h| h.join(".freshell").join("tabs-snapshots")),
            fresh_agent: fresh_agent_state.clone(),
        }))
```

(Adapt `auth_token`/`home`/`fresh_agent_state` to the exact local bindings
`main.rs` already passes to neighboring routers — `fresh_agent_state` exists at
`main.rs:623`.)

- [ ] **Step 6: Full check + commit**

Run: `cargo test -p freshell-server && cargo clippy -p freshell-server && cargo fmt --all -- --check`

```bash
git add crates/freshell-server/src/tabs_snapshots.rs crates/freshell-server/src/main.rs crates/freshell-freshagent/src/lib.rs
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
- Consumes: `freshell_freshagent::terminal_tabs::create_terminal_or_content_tab(state, body) -> Response` (now `pub`; re-export as `pub use terminal_tabs::create_terminal_or_content_tab;` from `freshell-freshagent/src/lib.rs` if the module itself is private); `read_generation` (Task 1).
- Produces: `POST /api/tabs-sync/restore` with body `{"deviceId": "...", "generation": 0, "dryRun": false}` → `200 {"deviceId", "generation", "sourceCapturedAt", "restored": [{"tabKey","paneId","kind","request"?, "tabId"?, "terminalId"?}], "skipped": [{"tabKey","paneId","kind","reason"}], "failed": [{"tabKey","paneId","kind","status","error"}]}`; `404` when no such snapshot; `400` when `deviceId` missing.
- Restore semantics (documented in the module doc AND the response):
  - Every OPEN record's pane becomes ONE new tab via `POST /api/tabs`-equivalent bodies (multi-pane tabs are flattened to one tab per pane — safety-net semantics; the layout tree is client-owned and not restorable server-side).
  - `kind:"terminal"` → `{"mode": payload.mode || "shell", "cwd": payload.initialCwd, "name": tabName, "sessionRef": payload.sessionRef}` (sessionRef included only when present; the create pipeline itself enforces provider==mode and stamps identity — that is the point of driving it).
  - `kind:"browser"` → `{"browser": payload.url, "name": tabName}`; `kind:"editor"` → `{"editor": payload.filePath, "name": tabName}`.
  - `kind:"fresh-agent"` and any other kind → `skipped` with `reason:"unsupported-kind"` (the REST create pipeline has no resume shape for agent chat panes — `create_tab` only accepts `agent:"opencode"` fresh creates, `freshell-freshagent/src/lib.rs:1158-1171`). This is REPORTED loudly in the response and by the operator script, not silent.

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

    fn mixed_snapshot() -> serde_json::Value {
        json!({
            "deviceId": "dev-1", "deviceLabel": "Dev One", "clientInstanceId": "c1",
            "serverInstanceId": "srv", "snapshotRevision": 3, "capturedAt": 2000,
            "records": [
                { "tabKey": "dev-1:t1", "tabId": "t1", "tabName": "shell tab", "status": "open",
                  "revision": 1, "updatedAt": 2000, "paneCount": 1,
                  "panes": [{ "paneId": "p1", "kind": "terminal",
                              "payload": { "mode": "shell", "initialCwd": "/tmp" } }] },
                { "tabKey": "dev-1:t2", "tabId": "t2", "tabName": "docs", "status": "open",
                  "revision": 1, "updatedAt": 2001, "paneCount": 1,
                  "panes": [{ "paneId": "p2", "kind": "browser",
                              "payload": { "url": "https://example.com" } }] },
                { "tabKey": "dev-1:t3", "tabId": "t3", "tabName": "chat", "status": "open",
                  "revision": 1, "updatedAt": 2002, "paneCount": 1,
                  "panes": [{ "paneId": "p3", "kind": "fresh-agent",
                              "payload": { "provider": "claude",
                                           "sessionRef": { "provider": "claude", "sessionId": "x" } } }] }
            ]
        })
    }

    #[tokio::test]
    async fn restore_rebuilds_supported_panes_and_reports_skips() {
        let dir = tempfile::tempdir().unwrap();
        seed_generation(dir.path(), "dev-1", "00000000000000002000-r3.json", mixed_snapshot());
        let state = test_state(dir.path());
        let (status, body) = post(
            router(state), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }), true,
        ).await;
        assert_eq!(status, StatusCode::OK);
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
    async fn restore_dry_run_creates_nothing_and_404_on_missing_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        seed_generation(dir.path(), "dev-1", "00000000000000002000-r3.json", mixed_snapshot());
        let (status, body) = post(
            router(test_state(dir.path())), "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1", "dryRun": true }), true,
        ).await;
        assert_eq!(status, StatusCode::OK);
        // dryRun: plan reported under "restored" with the would-be request, no tabId.
        assert_eq!(body["restored"].as_array().unwrap().len(), 2);
        assert!(body["restored"][0]["tabId"].is_null());
        let (status, _) = post(
            router(test_state(dir.path())), "/api/tabs-sync/restore",
            json!({ "deviceId": "ghost" }), true,
        ).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-server tabs_snapshots`
Expected: FAIL (route not registered → 404 / handler missing → compile error).

- [ ] **Step 3: Implement restore**

In `terminal_tabs.rs`, change the visibility (and only the visibility) of
`create_terminal_or_content_tab` (line 189) to `pub`, extending its doc
comment: "Also driven in-process by `freshell-server`'s
`POST /api/tabs-sync/restore` (continuity trio) — restore MUST reuse this
exact pipeline because it is the path that stamps session identity." Add
`pub use` in `freshell-freshagent/src/lib.rs` if `terminal_tabs` is a private
module: `pub use terminal_tabs::create_terminal_or_content_tab;`.

In `tabs_snapshots.rs` add to `router()`:

```rust
        .route("/api/tabs-sync/restore", axum::routing::post(restore_tabs))
```

Handler:

```rust
/// Map one snapshot pane to the `POST /api/tabs` body that recreates it, or
/// Err(reason) when the pipeline has no shape for this pane kind.
fn pane_to_create_body(tab_name: Option<&Value>, pane: &Value) -> Result<Value, &'static str> {
    let payload = pane.get("payload").cloned().unwrap_or_else(|| json!({}));
    let kind = pane.get("kind").and_then(Value::as_str).unwrap_or("");
    let name = tab_name.cloned().unwrap_or(Value::Null);
    match kind {
        "terminal" => {
            let mut body = json!({
                "mode": payload.get("mode").and_then(Value::as_str).unwrap_or("shell"),
                "name": name,
            });
            if let Some(cwd) = payload.get("initialCwd").filter(|v| v.is_string()) {
                body["cwd"] = cwd.clone();
            }
            if let Some(sref) = payload.get("sessionRef").filter(|v| v.is_object()) {
                body["sessionRef"] = sref.clone();
            }
            Ok(body)
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

async fn restore_tabs(
    State(state): State<TabsSnapshotsState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(device_id) = body.get("deviceId").and_then(Value::as_str) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "deviceId is required" })))
            .into_response();
    };
    let generation = body.get("generation").and_then(Value::as_u64).unwrap_or(0) as usize;
    let dry_run = body.get("dryRun").and_then(Value::as_bool).unwrap_or(false);
    let Some(snap) = state
        .snapshots_dir
        .as_deref()
        .and_then(|dir| freshell_ws::tabs::read_generation(dir, device_id, generation))
    else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Snapshot not found" })))
            .into_response();
    };

    let mut restored = Vec::new();
    let mut skipped = Vec::new();
    let mut failed = Vec::new();
    let records = snap.get("records").and_then(Value::as_array).cloned().unwrap_or_default();
    for record in &records {
        if record.get("status").and_then(Value::as_str) != Some("open") {
            continue;
        }
        let tab_key = record.get("tabKey").cloned().unwrap_or(Value::Null);
        let tab_name = record.get("tabName");
        let panes = record.get("panes").and_then(Value::as_array).cloned().unwrap_or_default();
        for pane in &panes {
            let pane_id = pane.get("paneId").cloned().unwrap_or(Value::Null);
            let kind = pane.get("kind").cloned().unwrap_or(Value::Null);
            match pane_to_create_body(tab_name, pane) {
                Err(reason) => skipped.push(json!({
                    "tabKey": tab_key, "paneId": pane_id, "kind": kind, "reason": reason,
                })),
                Ok(create_body) if dry_run => restored.push(json!({
                    "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "request": create_body, "tabId": Value::Null,
                })),
                Ok(create_body) => {
                    let resp = freshell_freshagent::create_terminal_or_content_tab(
                        state.fresh_agent.clone(),
                        create_body.clone(),
                    )
                    .await;
                    let status = resp.status();
                    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
                        .await
                        .unwrap_or_default();
                    let resp_body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                    if status.is_success() {
                        restored.push(json!({
                            "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                            "tabId": resp_body.get("tabId").cloned().unwrap_or(Value::Null),
                            "terminalId": resp_body.get("terminalId").cloned().unwrap_or(Value::Null),
                        }));
                    } else {
                        failed.push(json!({
                            "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                            "status": status.as_u16(), "error": resp_body,
                        }));
                    }
                }
            }
        }
    }

    Json(json!({
        "deviceId": device_id,
        "generation": generation,
        "sourceCapturedAt": snap.get("capturedAt").cloned().unwrap_or(Value::Null),
        "restored": restored,
        "skipped": skipped,
        "failed": failed,
    }))
    .into_response()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server tabs_snapshots -p freshell-freshagent`
Expected: PASS (and no regression in `freshell-freshagent`).

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
git add crates/freshell-server/src/tabs_snapshots.rs crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-freshagent/src/lib.rs port/oracle/DEVIATIONS.md
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
- Modify: `test/e2e-browser/playwright.config.ts` (append to `rust-chromium`'s `testMatch` with a doc comment, like every other rust-only spec at lines 121-168)

**Interfaces:**
- Consumes: `RustServer` + `bootAndConnect` + `harness.getTabCount()` (helpers); `POST /api/tabs`, `GET /api/tabs-sync/snapshots[/{device}]`, `scripts/restore-tabs.sh`; the fake-codex argv-recorder wiring — copy it EXACTLY from `test/e2e-browser/specs/codex-terminal-bounce-rust.spec.ts` (fake CLI is correct here: deliverable 1 proves identity plumbing, deliverable 2 proves real CLIs).
- Produces: the committed acceptance test for deliverable 1.

- [ ] **Step 1: Write the spec (failing only until Tasks 1-4 are in — if Tasks 1-4 are done it should pass; run it once with Task 1's persistence commented out locally if you want to see it red, do NOT commit that)**

Test skeleton (fill in the fake-codex/config seeding by copying the exact
blocks from `codex-terminal-bounce-rust.spec.ts` — do not invent your own):

```ts
import { expect, test } from '../helpers/fixtures.js'   // match sibling specs' import path exactly
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RustServer } from '../helpers/rust-server.js'
import { bootAndConnect } from '../helpers/test-harness.js'

const run = promisify(execFile)
const CODEX_SESSION_ID = '11111111-2222-4333-8444-555555555555'

test.describe('tabs-sync snapshot -> wipe -> one-command restore (rust only)', () => {
  test('restored tabs point at the SAME sessions', async ({ browser }) => {
    test.setTimeout(240_000)
    const server = new RustServer({
      env: { /* fake codex CLI wiring copied from codex-terminal-bounce-rust.spec.ts */ },
      setupHome: async (homeDir) => { /* config.json seeding copied from the same spec */ },
    })
    const info = await server.start()
    try {
      // -- populate: one page = one deviceId/clientInstanceId --
      const ctx1 = await browser.newContext()
      const page1 = await ctx1.newPage()
      const harness1 = await bootAndConnect(page1, info)
      const baseline = await harness1.getTabCount()

      const auth = { 'x-auth-token': info.token, 'content-type': 'application/json' }
      const mk = async (body: unknown) => {
        const r = await fetch(`${info.baseUrl}/api/tabs`, {
          method: 'POST', headers: auth, body: JSON.stringify(body),
        })
        expect(r.ok).toBe(true)
        return r.json()
      }
      await mk({ mode: 'shell', name: 'plain shell' })
      await mk({ browser: 'https://example.com', name: 'docs' })
      const codex = await mk({
        mode: 'codex', name: 'codex work',
        sessionRef: { provider: 'codex', sessionId: CODEX_SESSION_ID },
      })
      expect(codex.terminalId).toBeTruthy()

      // -- wait for the client's tabs.sync push to mint a persisted generation
      //    containing all three tabs (incl. the codex sessionRef) --
      let deviceId = ''
      await expect(async () => {
        const r = await fetch(`${info.baseUrl}/api/tabs-sync/snapshots`, { headers: auth })
        const data = await r.json()
        const dev = data.devices.find((d: any) => d.generations[0]?.recordCount >= baseline + 3)
        expect(dev).toBeTruthy()
        deviceId = dev.deviceId
        const snap = await (await fetch(
          `${info.baseUrl}/api/tabs-sync/snapshots/${deviceId}`, { headers: auth })).json()
        const codexPane = snap.records
          .flatMap((rec: any) => rec.panes)
          .find((p: any) => p.payload?.sessionRef?.provider === 'codex')
        expect(codexPane?.payload?.sessionRef?.sessionId).toBe(CODEX_SESSION_ID)
      }).toPass({ timeout: 30_000 })

      // -- wipe: close the populated context entirely (client state gone) --
      await ctx1.close()

      // -- fresh browser context = the wiped client --
      const ctx2 = await browser.newContext()
      const page2 = await ctx2.newPage()
      const harness2 = await bootAndConnect(page2, info)
      const freshCount = await harness2.getTabCount()

      // -- ONE COMMAND --
      const { stdout } = await run('scripts/restore-tabs.sh', [
        '--url', info.baseUrl, '--token', info.token, '--device', deviceId,
      ], { cwd: process.cwd() })
      expect(stdout).toContain('failed=0')

      // -- the wiped client received the restored tabs live --
      await expect(async () => {
        expect(await harness2.getTabCount()).toBe(freshCount + 3)
      }).toPass({ timeout: 20_000 })

      // -- SAME session: the restored codex terminal carries the identical
      //    sessionRef in the live terminal registry (server-side truth) --
      const terms = await (await fetch(`${info.baseUrl}/api/terminals`, { headers: auth })).json()
      const codexTerms = terms.items.filter((t: any) => t.mode === 'codex')
      expect(codexTerms.some(
        (t: any) => t.sessionRef?.sessionId === CODEX_SESSION_ID
          && t.terminalId !== codex.terminalId,   // a NEW terminal, same session
      )).toBe(true)
      await ctx2.close()
    } finally {
      await server.stop()
    }
  })
})
```

Adjust import specifiers/fixture names to match sibling specs exactly (open
`codex-terminal-bounce-rust.spec.ts` and mirror its imports, `test`/`expect`
source, and fake-CLI + `setupHome` blocks verbatim). `GET /api/terminals`
returns `sessionRef` for non-codex modes today via `resumeSessionId`
synthesis and for any mode via the identity registry (`terminals.rs:674-686`)
— if the codex item lacks `sessionRef` on this path, assert instead via the
harness Redux pane state (`harness2.getState().panes` → the restored pane's
`content.sessionRef`), which the `ui.command tab.create` payload carries
(`terminal_tabs.rs:1005-1010`). Use whichever source proves identity; prefer
asserting BOTH when available.

- [ ] **Step 2: Register the spec in `rust-chromium`**

In `playwright.config.ts`, append to the `rust-chromium` `testMatch` array:

```ts
        // CONTINUITY TRIO deliverable 1 (docs/plans/2026-07-22-continuity-safety-trio.md):
        // snapshot generations + one-command restore round-trip. Rust-only:
        // legacy has no persisted snapshot generations or restore endpoint.
        /snapshot-restore-rust\.spec\.ts$/,
```

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
(b) if not, does it at least accept the session id (argv leg fallback)? Iterate
the fixture shape until the CLI renders it, or conclude it genuinely cannot
render offline. **Fallback rule (spec-mandated):** any leg whose CLI cannot
render history offline downgrades to (i) claimed pane session id unchanged +
(ii) respawned argv contains the resume id — asserted via
`GET /api/terminals` (`sessionRef`) and the server debug log
(`info.debugLogPath`, the `terminal.created` record logs mode + resume id
since `136b9e94`). Document the downgrade + probe evidence in the spec header
comment AND the evidence file. Also record whether each CLI needs auth state
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
- Consumes: `RustServer` (`setupHome`, `restart()`), `bootAndConnect`, sidebar interactions (mirror `sidebar-click-resume.spec.ts:215-235`), `POST /api/tabs` with `sessionRef`, `GET /api/terminals`, `GET /api/terminals/{id}/search?q=<marker>` (server-side scrollback mirror — the strongest render assertion), Task 6 probe findings.
- Produces: `npm run smoke:continuity` — the pre-deploy gate. NOT run by `chromium`/`rust-chromium`/`legacy-chromium`.

- [ ] **Step 1: Register the project + npm script FIRST (so the spec never leaks into the default matrix)**

`playwright.config.ts` — add near the other project defs:

```ts
    // CONTINUITY SMOKE (pre-deploy gate, docs/plans/2026-07-22-continuity-safety-trio.md):
    // REAL freshell-server binary + REAL codex/amplifier/claude CLIs from PATH.
    // Deliberately OUTSIDE the default matrix -- run via `npm run smoke:continuity`.
    {
      name: 'continuity-smoke',
      use: { ...devices['Desktop Chrome'], e2eServerKind: 'rust' as const },
      testMatch: [/continuity-smoke\.spec\.ts$/],
    },
```

and add `testIgnore: [/continuity-smoke\.spec\.ts$/]` to the `chromium`
project (plus the CI `firefox`/`webkit` project entries — any project without
an explicit `testMatch`). Verify exclusion:
`npx playwright test --config test/e2e-browser/playwright.config.ts --list | grep -c continuity-smoke`
must show the spec ONLY under `[continuity-smoke]`.

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
import { expect, test } from '../helpers/fixtures.js' // mirror sibling imports
import fs from 'node:fs/promises'
import path from 'node:path'
import { RustServer } from '../helpers/rust-server.js'
import { bootAndConnect } from '../helpers/test-harness.js'

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

test.describe('continuity smoke (REAL CLIs) -- pre-deploy gate', () => {
  test('three real panes survive server restart + page reload with the same sessions', async ({ page }) => {
    test.setTimeout(300_000) // budget: whole scenario ~3-4 min
    const server = new RustServer({
      // NO CODEX_CMD / fake-CLI env: real binaries from PATH on purpose.
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
      const harness = await bootAndConnect(page, info)
      const auth = { 'x-auth-token': info.token, 'content-type': 'application/json' }
      const cwd = path.join(info.homeDir, 'proj')

      // -- LEG 1 (user path: sidebar click) -- codex --
      const sessionItem = page.getByText('MARKER-CODEX', { exact: false }).first()
      // (the sidebar lists the seeded session by extracted title; mirror
      //  sidebar-click-resume.spec.ts's locator strategy exactly)
      await sessionItem.click()

      // -- LEGS 2+3 (agent/API path: REST create with sessionRef) --
      for (const p of ['amplifier', 'claude'] as const) {
        const r = await fetch(`${info.baseUrl}/api/tabs`, {
          method: 'POST', headers: auth,
          body: JSON.stringify({
            mode: p, cwd, name: `smoke ${p}`,
            sessionRef: { provider: p, sessionId: IDS[p] },
          }),
        })
        expect(r.ok).toBe(true)
      }

      const expectContinuity = async (phase: string) => {
        // 1. tab count stable
        await expect(async () => {
          expect(await harness.getTabCount()).toBe(3 + /* baseline tabs from boot */ 0)
        }).toPass({ timeout: 30_000 })
        // 2. claimed session ids unchanged (server-side identity registry)
        // 3. MARKER visible in each pane's terminal (server scrollback mirror --
        //    proves the REAL CLI rendered the prior conversation)
        await expect(async () => {
          const terms = await (await fetch(`${info.baseUrl}/api/terminals`, { headers: auth })).json()
          for (const p of ['codex', 'amplifier', 'claude'] as const) {
            const t = terms.items.find((i: any) => i.mode === p)
            expect(t, `${phase}: ${p} terminal live`).toBeTruthy()
            expect(t.sessionRef?.sessionId, `${phase}: ${p} same session`).toBe(IDS[p])
            const s = await (await fetch(
              `${info.baseUrl}/api/terminals/${t.terminalId}/search?q=${encodeURIComponent(MARKERS[p].slice(0, 20))}`,
              { headers: auth })).json()
            expect(s.matches.length, `${phase}: ${p} MARKER rendered by real CLI`).toBeGreaterThan(0)
          }
        }).toPass({ timeout: 60_000 })
      }

      await expectContinuity('initial open')

      // -- DISRUPTION 1: server restart WITHOUT page reload --
      await server.restart()
      // wait for reconnect + respawn (harness reports ready again)
      await expect(async () => {
        expect(harness.getState()?.connection?.status ?? await harnessReady(page)).toBeTruthy()
      }).toPass({ timeout: 60_000 })
      await expectContinuity('after restart (no reload)')

      // -- DISRUPTION 2: page reload --
      await page.reload()
      await bootAndConnect(page, info)
      await expectContinuity('after reload')
    } finally {
      await server.stop()
    }
  })
})
```

Implementation notes (bake into the spec, adjusting to reality found while
writing):
- Baseline tab count: read `harness.getTabCount()` right after first
  `bootAndConnect` and assert `baseline + 3` thereafter — do not hardcode.
- Tab-count "same tab count" assertion applies after each disruption, per spec.
- The reconnect-wait: mirror how `codex-terminal-bounce-rust.spec.ts` waits
  after `server.restart()` (it solved exactly this; copy its wait, don't
  invent `harnessReady`).
- Sidebar leg: the seeded codex session's TITLE comes from the first user
  message — so the MARKER sentence doubles as the sidebar label; mirror
  `sidebar-click-resume.spec.ts`'s `sidebar-session-list` +
  `getByText(...).click()` flow.
- codex sessionRef for the sidebar leg is stamped by the client's gold path
  (`openSessionTab`), then re-derived server-side on restart — this is exactly
  the `136b9e94` surface the proof run exercises.
- If the Task 6 probe downgraded a leg (CLI cannot render offline): replace
  that leg's search assertion with (a) `sessionRef.sessionId` unchanged AND
  (b) the resume id present in the respawned terminal's create log line in
  `info.debugLogPath` — and say so in the header comment + evidence file.
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
FRESHELL_E2E_RUST_SERVER_BIN=/tmp/freshell-pre-136b9e94/target/release/freshell-server \
  npm run smoke:continuity 2>&1 | tee /tmp/smoke-pre-fix.out; echo "exit=$?"
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
npm run smoke:continuity 2>&1 | tee /tmp/smoke-head.out; echo "exit=$?"
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
  - `scripts/deploy-tab-diff.sh capture --url U --token T --out FILE` → writes `{"capturedAt", "url", "devices": {"<deviceId>": <newest snapshot>}, "terminals": [<items>]}`
  - `scripts/deploy-tab-diff.sh verify --url U --token T --before FILE` → exit 0 when every previously-live identity pane came back with the SAME `sessionRef`; exit 1 with a loud pane-by-pane diff (`MISSING` / `FRESH (identity lost)` / `RE-POINTED`) and the exact `restore-tabs.sh` remediation command otherwise.
  - Verify semantics: for each device in the before-file, for each open record pane that had a `payload.sessionRef` OR a `payload.liveTerminal`, find the same `(tabKey, paneId)` in the device's newest AFTER snapshot: absent → `MISSING`; before had `sessionRef` and after doesn't → `FRESH`; both present but `sessionId`/`provider` differ → `RE-POINTED`. Additionally a pane that was live before (had `liveTerminal`) must be live after (its after `liveTerminal.terminalId` exists in the after `/api/terminals` items) → else `NOT RESPAWNED`.

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
  terminals=$(curl -fsS "${auth[@]}" "${URL}/api/terminals" | jq '.items')
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
    # Pane-by-pane identity diff, computed in jq.
    DIFF=$(jq -n --slurpfile b "$BEFORE" --slurpfile a "$AFTER" '
      def panes(dev; snap):
        (snap.records // [])[] | select(.status == "open") as $rec
        | ($rec.panes // [])[]
        | {device: dev, tabKey: $rec.tabKey, tabName: $rec.tabName, paneId: .paneId,
           kind: .kind, sessionRef: .payload.sessionRef,
           liveTerminalId: .payload.liveTerminal.terminalId};
      ($b[0].devices | to_entries | map(panes(.key; .value)) | flatten) as $before
      | ($a[0].devices | to_entries | map(panes(.key; .value)) | flatten) as $after
      | ($a[0].terminals | map(.terminalId)) as $liveNow
      | [ $before[]
          | select(.sessionRef != null or .liveTerminalId != null)
          | . as $bp
          | ($after | map(select(.tabKey == $bp.tabKey and .paneId == $bp.paneId)) | first) as $ap
          | if $ap == null then
              {verdict: "MISSING", pane: $bp}
            elif ($bp.sessionRef != null and $ap.sessionRef == null) then
              {verdict: "FRESH (identity lost)", pane: $bp}
            elif ($bp.sessionRef != null and $ap.sessionRef != null
                  and ($bp.sessionRef.provider != $ap.sessionRef.provider
                       or $bp.sessionRef.sessionId != $ap.sessionRef.sessionId)) then
              {verdict: "RE-POINTED", pane: $bp, after: $ap.sessionRef}
            elif ($bp.liveTerminalId != null and
                  (($ap.liveTerminalId == null) or ($liveNow | index($ap.liveTerminalId) | not))) then
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
    echo "REMEDIATION (rebuild a device's tabs from its last-good snapshot):"
    jq -r '[.[].pane.device] | unique | .[] |
      "  scripts/restore-tabs.sh --url '"$URL"' --token <TOKEN> --device \(.)"' <<<"$DIFF"
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
import { expect, test } from '../helpers/fixtures.js' // mirror sibling imports
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { RustServer } from '../helpers/rust-server.js'
import { bootAndConnect } from '../helpers/test-harness.js'

const run = promisify(execFile)
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

async function tabDiff(args: string[]) {
  try {
    const { stdout } = await run('scripts/deploy-tab-diff.sh', args, { cwd: process.cwd() })
    return { code: 0, out: stdout }
  } catch (err: any) {
    return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

test.describe('deploy tab-diff ritual (rust only, ephemeral server)', () => {
  test('verify passes when identity survives a restart and fails loudly when it does not', async ({ page }) => {
    test.setTimeout(240_000)
    const server = new RustServer({
      env: { /* fake codex CLI wiring copied from codex-terminal-bounce-rust.spec.ts */ },
      setupHome: async (homeDir) => { /* config seeding copied from the same spec */ },
    })
    const info = await server.start()
    const before = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-')), 'before.json')
    try {
      const harness = await bootAndConnect(page, info)
      const auth = { 'x-auth-token': info.token, 'content-type': 'application/json' }
      // one identity pane + one plain pane
      const codex = await (await fetch(`${info.baseUrl}/api/tabs`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ mode: 'codex', name: 'work',
          sessionRef: { provider: 'codex', sessionId: SESSION_ID } }),
      })).json()
      await fetch(`${info.baseUrl}/api/tabs`, {
        method: 'POST', headers: auth, body: JSON.stringify({ mode: 'shell', name: 'sh' }),
      })
      // wait for a persisted generation carrying the codex sessionRef
      await expect(async () => {
        const r = await (await fetch(`${info.baseUrl}/api/tabs-sync/snapshots`, { headers: auth })).json()
        expect(r.devices.some((d: any) => d.generations[0]?.recordCount >= 2)).toBe(true)
      }).toPass({ timeout: 30_000 })

      // -- CAPTURE --
      const cap = await tabDiff(['capture', '--url', info.baseUrl, '--token', info.token, '--out', before])
      expect(cap.code).toBe(0)

      // -- HAPPY PATH: restart, wait for reconnect + respawn + a fresh push --
      await server.restart()
      await expect(async () => {
        const terms = await (await fetch(`${info.baseUrl}/api/terminals`, { headers: auth })).json()
        const c = terms.items.find((t: any) => t.mode === 'codex')
        expect(c?.sessionRef?.sessionId).toBe(SESSION_ID)  // respawned with same identity
        const r = await (await fetch(`${info.baseUrl}/api/tabs-sync/snapshots`, { headers: auth })).json()
        // a post-restart push landed (new generation newer than the capture)
        expect(r.devices.some((d: any) => d.generations[0]?.capturedAt >
          JSON.parse(await fs.readFile(before, 'utf8').then(String)).capturedAt)).toBe(true)
      }).toPass({ timeout: 60_000 })
      const ok = await tabDiff(['verify', '--url', info.baseUrl, '--token', info.token, '--before', before])
      expect(ok.out).toContain('OK: every previously-live pane came back')
      expect(ok.code).toBe(0)

      // -- FAILURE PATH: capture again, then make the identity pane come back
      //    WITHOUT identity (close it in the UI and create a fresh codex tab) --
      const before2 = before.replace('before.json', 'before2.json')
      expect((await tabDiff(['capture', '--url', info.baseUrl, '--token', info.token, '--out', before2])).code).toBe(0)
      // close the codex tab via the UI (its tabKey disappears from the next push)
      // -- mirror tab-management.spec.ts's close interaction, or close via
      //    harness redux dispatch if a helper exists --
      await closeTabContainingTerminal(page, codex.terminalId)
      await fetch(`${info.baseUrl}/api/tabs`, {  // fresh codex, NO sessionRef
        method: 'POST', headers: auth, body: JSON.stringify({ mode: 'codex', name: 'fresh' }),
      })
      await expect(async () => {  // wait until the new push (without the old pane) lands
        const r = await (await fetch(`${info.baseUrl}/api/tabs-sync/snapshots`, { headers: auth })).json()
        expect(r.devices.some((d: any) => d.generations[0]?.capturedAt >
          JSON.parse(await fs.readFile(before2, 'utf8').then(String)).capturedAt)).toBe(true)
      }).toPass({ timeout: 30_000 })

      const bad = await tabDiff(['verify', '--url', info.baseUrl, '--token', info.token, '--before', before2])
      expect(bad.code).not.toBe(0)                                  // exits non-zero
      expect(bad.out).toContain('TAB-DIFF DIVERGENCE')              // loud
      expect(bad.out).toMatch(/MISSING|FRESH \(identity lost\)/)    // names the category
      expect(bad.out).toContain('scripts/restore-tabs.sh')          // prints the remediation
      expect(bad.out).toContain('--device')
    } finally {
      await server.stop()
    }
  })
})
```

(`closeTabContainingTerminal`: implement inside the spec using the tab strip's
close affordance — find the pattern in `tab-management.spec.ts` and reuse it;
if closing via UI is flaky, an acceptable alternative simulation is
`DELETE /api/terminals/{id}` — `terminals.rs:105` — followed by the fresh
no-identity codex create: the pane then reports as FRESH/NOT-RESPAWNED. Either
way the verify MUST go red loudly; pick the one that is deterministic.)

- [ ] **Step 2: Register in `rust-chromium`**

```ts
        // CONTINUITY TRIO deliverable 3: deploy tab-diff ritual acceptance
        // (capture -> restart -> verify OK; identity loss fails loudly).
        /deploy-tab-diff-rust\.spec\.ts$/,
```

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

1. **Spec coverage:** D1 sessionRef persisted (Task 1 — client already pushes it, records opaque; test pins it), generations ~5 pruned under `~/.freshell/` (Task 1), restore drives POST /api/tabs with mode+cwd+sessionRef (Task 3), REST endpoint + one-command operator script incl. Nth generation (Tasks 3-4), e2e round-trip with mixed kinds + identity + fresh-context wipe + same-session assertion (Task 5). D2 real server + real CLIs (Task 7), seeded fixtures per real discovery layout with probes (Task 6), sidebar + REST open paths, restart-without-reload then reload, tab-count/session-id/MARKER assertions with documented per-CLI fallback rule, outside default matrix (`smoke:continuity`), FAIL@`136b9e94~1` / PASS@HEAD evidence (Task 8). D3 capture/verify GETs-only script with loud diff + restore remediation + non-zero exit (Task 9), e2e pass + loud-fail acceptance on ephemeral server (Task 10).
2. **Deferral audit (1b):** one intentional, LOUD limitation: restore recreates `terminal`/`browser`/`editor` panes and reports `fresh-agent` panes as `skipped: unsupported-kind` (the existing REST pipeline the spec mandates driving has no agent-resume shape — `freshell-freshagent/src/lib.rs:1158-1171`). This matches the spec's own restore definition ("POST /api/tabs with mode+cwd+sessionRef") and is surfaced in the endpoint response, the operator script output, and the module docs — not silent. The spec's acceptance scenario (mixed kinds incl. one with session identity) is fully covered by supported kinds. No requirement was moved to "future work".
3. **Placeholder scan:** remaining `<...>` tokens are run-time values (uuids, shas, captured output) or explicit mirror-this-file instructions pointing at a named existing spec/block — no TBD/TODO steps.
4. **Type consistency:** `with_persist_dir`/`list_generations`/`read_generation`/`sanitize_device_id`/`MAX_SNAPSHOT_GENERATIONS` names match across Tasks 1-3; `TabsSnapshotsState{auth_token, snapshots_dir, fresh_agent}` matches Tasks 2-3; script flags in Task 4 match the remediation lines printed in Task 9 and asserted in Task 10; `FRESHELL_E2E_RUST_SERVER_BIN` matches Tasks 6 and 8.
