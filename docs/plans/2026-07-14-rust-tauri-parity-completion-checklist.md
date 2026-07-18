# Rust/Tauri parity completion checklist

**Date:** 2026-07-14

**Branch:** `feat/rust-tauri-port`
**Purpose:** Complete the Rust server and native Tauri client so they can replace the legacy Node/Electron installation without lost data, missing controls, or a manual migration.

This is a work checklist, not a claim that the current port is ready. Every checkbox requires an automated Playwright proof against the Rust binary or the real Windows Tauri application. Unit and integration tests are still required where appropriate; the Playwright proof is the user-visible acceptance test.

The scope comes from a static comparison of every legacy HTTP route, every browser-to-server WebSocket message, configuration writer, session/indexing path, extension and provider runtime, retained React caller, Tauri desktop path, and the changes added to `main` after the port fork. A checkbox may combine closely coupled implementation details, but an oracle exclusion or a still-visible control is not grounds to omit the behavior.

## Definition of done

An item may be checked only when all of the following are true. These are completion rules, not separate work checkboxes:

- The behavior is implemented in the Rust/Tauri path, without changing the legacy behavior unless a deliberate bug fix is documented.
- A Playwright test failed for the missing behavior before the change and passes afterward.
- The test launches the actual Rust server or actual Tauri application. A mocked route alone does not count.
- The test uses an isolated temporary home and cannot read or modify the user's real `.freshell`, provider sessions, terminals, services, or firewall rules.
- The equivalent legacy Playwright scenario still passes, unless the item is an explicitly documented correction.
- Failures retain a Playwright trace, screenshot, browser console, Rust logs, exact child-process list, and the isolated configuration directory.
- Relevant lower-level Rust and TypeScript tests pass, followed by the coordinated repository suite.

## Required Playwright test lanes

These harness items come first. Later validation descriptions refer to their IDs.

- [x] **HARNESS-01 — Add an owned Rust-server fixture.** Create a Playwright fixture that builds or locates `freshell-server`, starts it on an ephemeral port with a unique token and isolated `FRESHELL_HOME`, records its exact PID, waits for health, and stops only that PID and its owned children.
  - **Playwright validation:** A harness self-test starts the Rust binary, opens `/?token=...&e2e=1`, creates a shell pane, prints a marker, restarts the same owned server with the same home, reconnects, and finally asserts that the server and all fixture-owned children exited while an unrelated sentinel process remained alive.
  - **Evidence (2026-07-16):** `test/e2e-browser/helpers/rust-server.ts` + `specs/harness-01-rust-server.spec.ts` (commits 334f834b, 2cb57287). Self-test green on repeated runs (`--project=rust-chromium`, 25-36s). Real PTY-child PIDs enumerated pre-kill and asserted dead post-stop (RED-demoed: stubbed capture fails); sentinel outside the group survives; real `~/.freshell` untouched. Spec review: APPROVED after one NEEDS-CHANGES round (process-group assertion theater fixed).

- [x] **HARNESS-02 — Make shared browser specifications run as a Node/Rust matrix.** Generalize the existing target seam so the same spec can request `legacy` or `rust`, including tests that need restart and filesystem access.
  - **Playwright validation:** A matrix smoke runs one settings, session, terminal, browser-pane, and multi-client scenario against both implementations and reports two named projects. Deliberately returning a different health/version payload from a mutation fixture must fail only the Rust project, proving the matrix is not accidentally reusing Node.
  - **Evidence (2026-07-16):** Projects `legacy-chromium`/`rust-chromium` over shared MATRIX_SPECS covering all five categories (commits 567ab1be, 4f582798): settings (settings-persistence-split — rust leg is a `test.fail`-annotated expected failure on genuine gap CFG-04/SESSION-13), session (session-directory-matrix), terminal (terminal-lifecycle), browser-pane, multi-client, plus restart/fs (server-restart-recovery via handle.restart()). Bite proof: `harness-02-matrix-bite.spec.ts` keys on real Node-persists/Rust-regenerates instanceId behavior; RED-demoed by mis-wiring the actual rust construction path to TestServer → rust project failed, legacy unaffected. Reviewer-adjudicated note: this uses a real behavioral discriminator rather than a literal injected "mutation fixture" — judged a substantively stronger equivalent. Known orthogonal flake: multi-client reconnect test fails identically on legacy/rust/default-chromium (pre-existing, tracked in review notes; not a matrix defect).

- [ ] **HARNESS-03 — Add deterministic provider fixtures.** Provide fake Claude, Kilroy/Claude-SDK, Codex app-server, OpenCode server, Amplifier, Gemini, and Kimi executables that record arguments/environment and emit controllable session, activity, approval, question, completion, crash, and resume events.
  - **Playwright validation:** A fixture-only contract spec invokes each executable/protocol directly, sends scripted commands, and asserts its ledger/events without requiring Rust provider parity. The later `TERM-*`/`AGENT-*` items validate the real pane picker and server integration.

- [ ] **HARNESS-04 — Add a multi-provider session corpus builder.** Generate isolated Claude, Codex, OpenCode, and Amplifier histories, including archived/deleted sessions, summaries, provider titles, nested git repositories, worktrees, fractional timestamps, and more than one page of results.
  - **Playwright validation:** A fixture-only contract parses the corpus manifest/hashes and optionally opens it through legacy to prove expected semantics; it does not require Rust multi-provider indexing. It deletes the temporary home and proves the real home was untouched.

- [ ] **HARNESS-05 — Add raw HTTP and WebSocket clients to the Playwright runner.** Tests need to send malformed frames, delay reads/hello, create slow consumers, inspect frames/close codes, and call orchestration routes.
  - **Playwright validation:** Exercise the helper against a deterministic echo/error fixture: delayed receive truly stops socket draining, sent/received bytes and close codes are recorded, abort works, and a second normal socket stays usable. Rust protocol semantics are tested later.

- [ ] **HARNESS-06 — Add deterministic proxy, file, SMB, editor, AI/Kilroy, update, and HTTPS fixtures.** Include HTTP, WebSocket, hot-reload, local/Windows-share trees, fake editor, summary AI, full Kilroy runtime, signed update feed, and trusted HTTPS.
  - **Playwright validation:** A fixture smoke reaches every target directly, mounts/reads the disposable SMB share on Windows, records editor/Kilroy invocations, returns fixed AI output, downloads a harmless signed artifact, and verifies the test certificate.

- [ ] **HARNESS-07 — Add a native Windows Tauri Playwright fixture.** Launch the exact `freshell-tauri.exe` with unique `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`, and WebView2 user-data paths; make `FRESHELL_HOME` optional so fallback tests are real. Set an ephemeral WebView2 remote-debugging port and attach with `chromium.connectOverCDP()`.
  - **Playwright validation:** Launch two isolated runs with different storage sentinels, connect to each real WebView2 page, assert no file/localStorage/token leakage, capture artifacts, close exact app PIDs, and prove each owned server was reaped. A mirror Chromium page does not count.
  - **Reference:** [Microsoft WebView2 remote-debugging argument](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl) and [Playwright `connectOverCDP`](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp).

- [ ] **HARNESS-08 — Add a test-only Tauri control plane.** Under an explicit E2E build flag only, expose read-only desktop state plus safe commands to trigger the same production handlers used by close, tray, hotkey, updater, renderer-failure, and daemon events. Ensure it cannot compile into release builds.
  - **Playwright validation:** A native Tauri spec proves the bridge is present in an E2E build, invokes each handler and observes the real window/process state, then launches a release build and asserts the bridge is absent.

- [ ] **HARNESS-09 — Add Windows host assertions to the Playwright runner.** Provide ownership-safe helpers for process trees, listening ports, files, shortcuts, scheduled tasks/services, firewall rules, installed application metadata, and window visibility. Mutating checks must run only in a disposable VM or Windows Sandbox.
  - **Playwright validation:** A self-test creates uniquely named disposable process/file/firewall fixtures, observes them, removes only those exact fixtures, and verifies a pre-existing sentinel fixture was preserved.

- [ ] **HARNESS-10 — Add legacy-profile and WebView storage migration fixtures.** Build a synthetic Electron profile containing server/desktop config, browser preferences, 16 representative tabs/panes, overrides, recents, colors, and migration markers.
  - **Playwright validation:** Launch legacy Electron against the fixture and assert its source manifest, hashes, visible state, and safe copy behavior. Tauri import is intentionally deferred to `MIGRATE-*` acceptance tests.

- [ ] **HARNESS-11 — Make accessibility selectors a gate.** Add reusable helpers/lint assertions requiring stable roles and accessible names; feature tests must not rely on CSS implementation details.
  - **Playwright validation:** A helper self-test uses only roles/labels/keyboard on existing main UI controls and deliberately fails on an inaccessible fixture control. Full wizard/chooser/settings coverage belongs to `GATE-07` after those features exist.

- [ ] **HARNESS-12 — Add leak and resource measurements.** Capture server/Tauri/provider child PIDs, handles, RSS, queue sizes, and listening ports before and after stress scenarios.
  - **Playwright validation:** A repeated create/send/close/restart loop returns to a bounded resource baseline, leaves no owned process or port behind, and fails with a retained process-tree artifact if the bound is exceeded.

- [ ] **HARNESS-13 — Add packaged Windows native-action automation.** From the Playwright runner, use Windows UI Automation and real OS keystrokes/clicks to open the shipped tray/menu/window controls; this complements but cannot be replaced by the instrumented E2E control plane.
  - **Playwright validation:** Install an exact release build, open the real tray menu and native app menu, invoke one production action from each plus the saved global hotkey, and assert the real WebView/process effect. No E2E control endpoint may exist in this build.

- [ ] **HARNESS-14 — Add a controllable server clock.** Share one test clock across idle cleanup, rate windows, tab/device TTLs, retention, and timeout tests without wall-clock sleeps.
  - **Playwright validation:** Advance/freeze/reset the clock from one serial spec, assert fixture timers fire in deterministic order, and launch a normal build to prove the control surface is absent.

### Validation shorthand

- **`PW-RUST`** means Playwright owns the real Rust server through `HARNESS-01`, its isolated home, fixtures, exact PID, restart, and teardown. Pointing an external browser at somebody else's running server is insufficient.
- **`PW-TAURI-WIN`** means Playwright owns and drives a native Windows Tauri/WebView2 E2E build through `HARNESS-07`; `HARNESS-08` may inspect/trigger production handlers, but this lane does not prove shipped native wiring.
- **`PW-TAURI-WIN-PACKAGED`** (also written as an explicitly “packaged” Tauri validation) means the exact installed release build, with no E2E control plane, driven through WebView2 plus `HARNESS-09`/`HARNESS-13` real Windows actions. Tray/menu/hotkey/shell/installer claims require this lane.
- **`Playwright Electron`** means the existing Playwright Electron launcher is used against an isolated legacy profile to establish or verify migration input.
- **`stress project`** means a serial, resource-instrumented Playwright project with explicit RSS/handle/latency/queue limits and deterministic teardown.
- Calls made with Playwright's `page.request`, `request`, raw WebSocket helper, or Node process APIs still count as Playwright validation because the Playwright test owns the complete user scenario and its artifacts. A standalone curl/script result does not satisfy the checkbox.

## P0 — Configuration safety and migration

- [ ] **CFG-01 — Make every `config.json` write lossless.** Preserve `sessionOverrides`, `terminalOverrides`, `projectColors`, `recentDirectories`, `completedMigrations`, `legacyLocalSettingsSeed`, Codex secrets, and unknown future keys on every writer.
  - **Playwright validation (`PW-RUST`):** Seed unique sentinels and parameterize settings save, terminal rename/delete, session mutation, project color, recent-directory update, provider migration, network change, title migration, and startup normalization. After each isolated action/restart, deep-compare the file and allow only that writer's intended paths to differ.

- [ ] **CFG-02 — Serialize concurrent server-configuration writes.** Route every `config.json` caller through one atomic queued store; `desktop.json` has its own Tauri queue under `TAURI-25`.
  - **Playwright validation (`PW-RUST`):** In parallel from two contexts, change settings, rename a terminal/session, set a project color, and add a recent directory. After all accepted operations and restart, assert valid JSON containing the final independent value from every writer.

- [ ] **CFG-03 — Add backup, fallback, and visible write-error handling.** Retain the last valid configuration; on parse, version, or read failure, load safe defaults with the truthful fallback reason and backup availability, then offer an explicit restore. Automatic backup restoration is a deliberate safety improvement only if separately documented and tested.
  - **Playwright validation (`PW-RUST`):** Parameterize parse error, unsupported version, and read failure with/without a valid backup; assert the exact warning/default state, use Restore when offered and verify values, then force a write failure and assert an error while primary/backup remain intact.
  - PARTIAL (2026-07-18): commit `41b04143` adds a `config.backup.json` refresh on every successful persist plus a conservative restore-on-load policy in `SettingsStore` (closing a real legacy data-loss gap where any read failure would overwrite both the config AND its backup with bare defaults), with Rust unit tests in `settings_store.rs` (including an outcome-oriented "preserving every last good value" test proven RED against a hand-spliced pre-fix version). MISSING: Rust-level tests only, not a `PW-RUST` spec — no browser-visible warning/default-state assertion, no UI Restore-action flow, and no write-failure-while-primary/backup-remain-intact spec.

- [ ] **CFG-04 — Restore automatic legacy browser-preference seeding.** Return and consume `legacyLocalSettingsSeed` once for a fresh WebView/browser profile, including theme, browser-local sidebar presentation, scale, terminal font, and sound. Server-backed first-chat exclusions remain in `config.json` and are covered by `SESSION-13`.
  - **Playwright validation (`PW-RUST`):** Start with seeded legacy settings and empty browser storage, open Rust, assert every visible preference, reload twice, and verify the one-time migration marker prevents stale seed values from overwriting a later user change.

- [ ] **CFG-05 — Pass the Electron→Tauri browser-state migration umbrella gate.** This cross-cutting gate depends on `MIGRATE-01` through `MIGRATE-10`; it is not a second implementation path.
  - **Playwright validation (`PW-TAURI-WIN`):** Run the complete migration suite on `HARNESS-10`, assert all 16 layouts/preferences/provider identities without manual storage edits, then require the atomicity, rollback, idempotence, coexistence, and receipt checks from every dependent `MIGRATE-*` item.

- [ ] **CFG-06 — Eliminate boot-time settings snapshots.** Every new operation and newly connected or reconnected client must resolve current values from the live store; dedicated `TERM-*`, `FILE-05`, `DIAG-04`, and provider tests prove each consumer.
  - **Playwright validation (`PW-RUST`):** Change representative launch/file/log settings, connect a second page, then force the first page's WebSocket to reconnect without restarting. Assert both handshakes and immediately created operations use the new values, the original page does not revert, and existing sessions retain only fields documented as session-scoped.

- [ ] **CFG-07 — Persist a stable server installation identity.** Reuse one instance ID for the same home across restarts and create a different ID for a different home.
  - **Playwright validation (`PW-RUST`):** Record the server ID and synced client record, restart twice with the same isolated home and assert equality, then launch with a second home and assert inequality without losing the first server's tabs.

- [ ] **CFG-08 — Own durable tab-registry storage and crash recovery.** Persist open/closed client records with legacy caps, hashes, TTLs, migration, and corruption recovery instead of keeping them only in memory. `AUTO-15` owns revision/conflict/retirement semantics on top of this store.
  - **Playwright validation (`PW-RUST`):** Publish distinct tab sets from two contexts, close one source without sending retirement, crash/restart Rust, and query from a new observer before either source reconnects or republishes. Assert the exact stored open/closed state, then inject one corrupt record and assert only that record is quarantined.

- [ ] **CFG-09 — Preserve and learn recent directories and restore candidate-source precedence.** Record a deduplicated 20-item MRU and merge it in the documented order with live-terminal cwd, indexed projects, provider cwd values, and `defaultCwd`.
  - **Playwright validation (`PW-RUST`):** Launch in 22 folders, reuse an old one, and seed deliberate duplicates across every source. Before restart, assert the active terminal cwd occupies its documented source position; after restart, assert the 20-item persisted MRU cap plus stable unique precedence for indexed/provider/default sources without pretending the runtime terminal survived.

- [ ] **CFG-10 — Make schema/provider migrations idempotent and lossless.** Migrate legacy `freshclaude`/`agentChat`, seed missing `knownProviders`, append/enable newly discovered providers, and never shrink persisted providers because one discovery run is empty; preserve unknown fields and record completion only after success.
  - **Playwright validation (`PW-RUST`):** Parameterize each legacy shape, initial `enabledProviders=[claude,codex]`, missing known list, and temporary empty discovery. Interrupt the one-shot schema migration, restart, and assert correct modern values, unrelated sentinels, no provider loss, and exactly one schema marker. On a later boot after that marker exists, discover another provider and assert repeatable reconciliation still appends/enables it without rerunning the schema migration.

- [ ] **CFG-11 — Make atomic writes crash-safe on Linux and Windows.** A process interruption may leave either the complete old document or complete new document, never truncated/mixed JSON; stale temporary files must be cleaned without racing a current write.
  - **Playwright validation (`PW-RUST`, native Windows project):** Pause an E2E build after temp-file flush and before replacement, terminate the exact server, restart and assert a complete valid old/new config; seed old and recent temp files and assert only safely stale files are removed.

- [ ] **CFG-12 — Preserve the browser-local/server-wide settings split.** Browser appearance/sidebar preferences must remain per profile while server launch/file/network settings replicate to every client.
  - **Playwright validation (`PW-RUST`):** Use two isolated browser contexts, change theme/sidebar sort and default cwd in A, assert B keeps its local appearance but receives the cwd, then reload both and restart Rust to prove both persistence paths.

## P0 — Session history and sidebar parity

- [ ] **SESSION-01 — Index Claude, Codex, OpenCode, and Amplifier histories.** Use the same provider-specific identity, title, summary, timestamp, project, and resume information as legacy.
  - **Playwright validation (`PW-RUST`):** Seed `HARNESS-04`, open the sidebar, and assert named sessions from all four providers appear with correct icons, titles, projects, ordering, and resumable identities.
  - PARTIAL (2026-07-18): `test/e2e-browser/specs/session-directory-matrix.spec.ts` — sidebar-visibility test proves all four provider families (Claude/Codex/OpenCode, Amplifier gated to `rust-chromium` only) render with correct titles; the API-parity test proves identity (provider+sessionId), project/cwd, and `lastActivityAt`-DESC ordering for all four (Amplifier rust-gated); 8/8 green both projects, 2 runs each. MISSING: icons are not asserted by either test, and the API test's own scope note states it does NOT exercise resuming a session through the UI, so "resumable identities" remains unproven. Amplifier legs are `rust-chromium`-only (legacy has no Amplifier provider on this frozen branch).

- [ ] **SESSION-02 — Apply all saved session overrides.** Honor title, summary, archive, deletion, creation-time, and other actual override fields while retaining provider-authoritative fields where required; session type belongs to `SESSION-06`'s separate metadata store.
  - **Playwright validation (`PW-RUST`):** Seed conflicting provider metadata and overrides, load the normal sidebar/History list, and assert title/summary, archived icon/order, hidden deletion, and created-time ordering; restart and assert the same projection.

- [ ] **SESSION-03 — Implement session rename, summary, archive/unarchive, delete, and created-time correction.** Wire the actual context-menu controls to Rust; created-time correction is an API operation, and soft deletion must preserve provider source files.
  - **Playwright validation (`PW-RUST`):** Exercise rename, summary, archive/unarchive, and delete through accessible menus/confirmation, set `createdAtOverride` through `page.request`, assert immediate sidebar/History/search/order changes, reload/restart, and inspect isolated config/source files.

- [ ] **SESSION-04 — Implement provider-aware title and AI-title behavior.** Respect the full priority ladder—user > AI > first message > legacy > provider/directory fallback—plus provider-authoritative Claude/Amplifier cases and one-time stale-AI-title cleanup.
  - **Playwright validation (`PW-RUST`):** Seed one session per priority source, test no-key first-message fallback and deterministic fake-AI success, then add higher/lower sources in conflict order; assert only the documented winner, source in API/config, cleanup marker, and stable cold-restart result.

- [ ] **SESSION-05 — Implement project colors.** Save, broadcast, and render the legacy color treatment on History project headers.
  - **Playwright validation (`PW-RUST`):** Choose a project color in one browser, assert the History project header updates in two contexts, reload/restart, and verify persistence plus unchanged unrelated project colors.

- [ ] **SESSION-06 — Implement session type/flavor metadata and classification.** Persist and expose the separate metadata store used by icons, context-menu actions, and resume behavior.
  - **Playwright validation (`PW-RUST`):** Seed/edit each supported type through API, assert API metadata plus the correct icon/actions/open runtime, then restart and resume one session from each class.

- [ ] **SESSION-07 — Implement full-text and user-message search with complete pagination and stale-query cancellation.** Search titles, summaries, and message bodies across all providers and continue past the first 50 results.
  - **Playwright validation (`PW-RUST`):** Seed more than 100 sessions with distinct late user/full-text matches in Claude, Codex, OpenCode, and Amplifier, load every page, then begin a deliberately slow query and replace it with a fast query; assert all/only expected per-provider results and that stale results never overwrite the current sidebar.
  - PARTIAL (2026-07-18, commit bb29e9db): title/userMessages/fullText tier search + cursor pagination ported to legacy contract (scan budget, early-stop, partial/partialReason, override-title matching) with 23 crate tests + a sidebar-search Playwright test green 2x both kinds. MISSING: stale-query cancellation; file-content search for OpenCode/Amplifier; the >100-session multi-provider PW scenario above.

- [ ] **SESSION-08 — Implement repository and worktree grouping.** Resolve git roots without collapsing unrelated directories; preserve the sidebar's flat subtitles and History's project grouping.
  - **Playwright validation (`PW-RUST`):** Seed a repository, two linked worktrees, a nested repository, and a similarly named nonrepository folder; toggle Repository and Worktree grouping modes and assert the exact expected flat-sidebar subtitles and History groups/expand behavior in each, without inventing cross-restart expansion persistence.

- [ ] **SESSION-09 — Wire live watching and coalesced `sessions.changed`.** New, modified, moved, and deleted provider files must produce one effective directory revision/render after coalescing native watcher bursts.
  - **Playwright validation (`PW-RUST`):** Keep two pages open and perform at least one logical mutation through each real backend shape—Claude JSONL, Codex history, OpenCode SQLite/direct listing, and Amplifier history—plus create/rename/append/delete cases. Assert both pages converge on one effective revision/render per logical mutation with stable focus and no refresh storm/full-list flicker.
  - PARTIAL (2026-07-18): `test/e2e-browser/specs/session-directory-matrix.spec.ts` :: "a session written mid-test appears in the sidebar without a reload" — a NEW Claude-JSONL session written into the live isolated HOME after boot appears in the sidebar within ~10s without a page reload; green both projects (legacy's real fs watcher is the control, Rust's `sessions.changed` broadcast off the periodic sweep is the proof). Also `0855e27f` fixed the sweep being structurally blind to override-only mutations (rename/archive/delete). MISSING: only the "create" case on one backend (Claude) is exercised; modified/moved/deleted cases and the Codex/OpenCode/Amplifier backend shapes are untested here, as is the two-page convergence-with-stable-focus/no-refresh-storm assertion.

- [ ] **SESSION-10 — Join history to live terminals.** Report running IDs, associate discovered sessions with terminals, and focus/reuse the live pane instead of opening duplicates.
  - **Playwright validation (`PW-RUST`):** Start a fake provider terminal, emit its durable session ID, assert the sidebar marks it running, click the history item from another tab/context, and assert the existing terminal is selected and only one owner exists.
  - PARTIAL (2026-07-18): `restore-matrix.spec.ts` scenario 3 ("opening a seeded historical session from the sidebar gets a real pane title and non-blank content") was fixed and is now green both projects, 2x — the root cause was a spec bug (single-turn seed classified `isNonInteractive` and filtered out), not a product defect; adjacent evidence that resuming a session from the sidebar produces real, non-blank content. MISSING: this scenario opens a session that is NOT currently live elsewhere, so it does not test SESSION-10's actual clause — starting a fake provider terminal, marking it running in the sidebar, clicking that running history item from another context, and asserting the SAME terminal is reused with only one owner (no duplicate). The campaign status doc's open item #2 ("fresh codex terminal residual sidebar duplicate") remains unresolved.

- [ ] **SESSION-11 — Implement session repair and status events.** Repair late/missing associations, stale running state, and incomplete provider metadata while exposing truthful startup/index status.
  - **Playwright validation (`PW-RUST`):** Delay the provider session-init event until after terminal creation, then deliver it and assert association/title repair without a reload; crash and restart the server and assert stale running state clears while history remains.

- [ ] **SESSION-12 — Restore terminal-to-session rename and title synchronization.** Terminal rename, user session rename, and provider title updates must follow the unified precedence rules.
  - **Playwright validation (`PW-RUST`):** Rename from the tab, then from History, then emit a provider title; assert tab/sidebar values after each step and inspect the API/config title source after restart.

- [ ] **SESSION-13 — Restore the two server-wide first-chat exclusion controls.** Preserve `excludeFirstChatSubstrings` and `excludeFirstChatMustStart` in `config.json`, replicate them to every client, and apply them to complete multi-provider data.
  - **Playwright validation (`PW-RUST`):** Seed start/middle/no-match sessions across providers, edit both controls in A, assert exact membership in A and B, reload/restart, and verify the shared values and results persist.

- [ ] **SESSION-14 — Normalize provider timestamps and persisted recency.** Floor fractional epoch milliseconds in the session-directory/API projection and keep stable deterministic ordering; `sessions.changed` carries only its revision, and live busy overlays remain in `TERM-15`.
  - **Playwright validation (`PW-RUST`):** Seed boundary/fractional timestamps, inspect integer directory/API values, record the corresponding revision-only change notification, and assert stable ordering/cursors before and after refresh/restart with no oscillation.

- [ ] **SESSION-15 — Restore every real browser-local visibility filter.** Cover empty sessions, subagents, Codex subagents, noninteractive sessions, and other retained local presentation switches across supported providers; archive/delete projection belongs to `SESSION-02/03`.
  - **Playwright validation (`PW-RUST`):** Seed one session in every class, toggle each accessible local setting in A, assert exact membership, reload A for persistence, and assert isolated browser profile B retains its own values rather than receiving A's.

- [ ] **SESSION-16 — Tolerate malformed and partially written provider data.** Keep healthy sessions available, quarantine bad records, and index a record once it becomes valid.
  - **Playwright validation (`PW-RUST`):** Seed healthy, empty, truncated, malformed, and invalid-UTF-8 records for every provider, assert healthy sidebar/search remains usable, then complete a partial record and observe one live addition without restart.

- [ ] **SESSION-17 — Use provider-qualified identity everywhere.** Same raw IDs from different providers must never share overrides, mutations, running state, or resume targets.
  - **Playwright validation (`PW-RUST`):** Seed identical raw IDs for all providers, independently rename/archive/delete/open each, and assert no operation or live association leaks to a sibling provider before or after restart.

- [ ] **SESSION-18 — Support extension-owned session providers generically.** Session discovery and resume must not be limited to hardcoded built-ins.
  - **Playwright validation (`PW-RUST`):** Install a deterministic session-providing extension, assert its history/icon/search/open behavior, disable/remove it and observe clean removal, then re-enable and resume the same fixture identity.

- [ ] **SESSION-19 — Return accurate match tier and safe snippets.** Identify title/user/full-text matches, bound context, escape content, and avoid leaking unrelated messages.
  - **Playwright validation (`PW-RUST`):** Search unique markers in each tier including HTML/control-character text, assert the visible matched-in label/highlight/bounded escaped snippet, and verify no neighboring secret sentinel appears.

- [ ] **SESSION-20 — Serve directory/search from a cached indexed read model.** Do not rescan every provider directory synchronously on each request; incremental watcher/index updates must keep terminal interaction responsive.
  - **Playwright validation (`PW-RUST`, stress project):** Seed a large corpus, repeat sidebar/search/pagination requests while typing latency markers into a terminal, and assert provider scan counters do not increase after initial indexing, response/keystroke latency stays bounded, and one changed file updates incrementally.

- [ ] **SESSION-21 — Backfill missing Claude history records idempotently.** Repair a valid orphan transcript absent from Claude's history index without duplicating it.
  - **Playwright validation (`PW-RUST`):** Boot with one valid transcript missing from `history.jsonl`, assert one visible session and one repaired history entry, restart twice, and assert the file/sidebar still contain exactly one entry.

- [ ] **SESSION-22 — Support legacy and provider-qualified session-override keys.** Migrate/apply old raw-ID keys and modern `provider:id` keys with explicit precedence and no cross-provider leakage.
  - **Playwright validation (`PW-RUST`):** Seed raw, modern, and conflicting keys plus same-ID sessions from multiple providers; assert the intended override applies once, restart/migrate, and verify all 528-style legacy entries remain usable and unrelated providers untouched.

## P0 — Terminal creation, restoration, and safety

- [ ] **TERM-01 — Launch every registered terminal mode on each supported platform.** Restore shell, WSL, CMD, PowerShell, Claude, Codex, OpenCode, Amplifier, Gemini, and Kimi launch behavior, including extension-defined modes.
  - **Playwright validation (`PW-RUST`, Windows project where applicable):** Select every mode through the real pane picker, wait for its deterministic fixture banner, send a marker, and assert the recorded executable, arguments, environment, working directory, and platform-specific path conversion.

- [x] **TERM-02 — Use the managed Codex app-server path.** Launch Codex with the managed remote connection, disable unsupported app behavior, capture durable thread identity, and retain the lifecycle/ownership contract.
  - **Playwright validation (`PW-RUST`):** The fake Codex app-server records the remote handshake and emits a thread ID; Playwright sends two turns, reloads and restarts Rust, resumes the same thread, and asserts no standalone second Codex process or duplicate conversation was created.
  - EVIDENCE (2026-07-18, commit <pending>): `test/e2e-browser/specs/restore-matrix.spec.ts` :: "FreshCodex targets the same durable thread with no duplicate conversation after a full server restart" (scenario 5) now proves ALL of TERM-02: durable thread identity, restart resume, no duplicate conversation, AND "disable unsupported app behavior" — both `server/coding-cli/codex-managed-config.ts`'s `CODEX_MANAGED_REMOTE_CONFIG_ARGS` and `crates/freshell-freshagent/src/codex.rs`'s `CODEX_MANAGED_CONFIG_ARGS` splice `['-c', 'features.apps=false']` into every codex app-server launch, disabling Codex's own "apps" feature for the managed connection. The fixture records the exact argv the spawned process received (`FAKE_CODEX_APP_SERVER_ARG_LOG`); the test asserts `-c`/`features.apps=false` are adjacent in that argv — a real assertion against the actual spawn args on both server kinds, not a code-inspection claim. Green both projects, 2x full-spec runs (12/12 both times).

- [ ] **TERM-03 — Restore imported provider tabs by canonical `sessionRef`.** Support current durable identities as well as safe migration of older `resumeSessionId` data; return proven identity and durability in `terminal.created`.
  - **Playwright validation (`PW-RUST`, `PW-TAURI-WIN`):** Import the 16-tab migration fixture, start Tauri, and assert every restorable Claude, Codex, OpenCode, and Amplifier tab resumes the fixture's expected session marker rather than starting fresh; non-restorable panes must show a clear recovery choice.

- [ ] **TERM-04 — Deduplicate terminal creation requests.** Make `createRequestId` idempotent across retry, reconnect, delayed responses, and two clients.
  - **Playwright validation (`PW-RUST`):** Intercept/delay the first `terminal.created`, force reconnect, and issue the same create request from two pages; assert one PTY PID, one terminal ID, one pane owner, and one fixture launch record.

- [ ] **TERM-05 — Reuse canonical live-session owners.** Honor `liveTerminal` and provider session ownership so one durable session cannot acquire duplicate terminal owners.
  - **Playwright validation (`PW-RUST`):** Open the same history session simultaneously from two contexts and through the orchestration API; assert all views attach to one terminal and output is shared byte-for-byte.

- [ ] **TERM-06 — Enforce expected-session identity.** Validate `expectedSessionRef` independently on attach, input, resize, and restore; block input while identity is unresolved and provide a recoverable mismatch response.
  - **Playwright validation (`PW-RUST`):** Table-drive all four operations with expected A/actual B, asserting exact error frames, no replay/provider input/PTY resize/restore side effect, then repeat each with A and assert one successful effect.

- [ ] **TERM-07 — Honor attach intent, priority, replay budget, geometry, and request correlation.** Implement viewport hydration, keepalive delta, transport reconnect, foreground/background policy, `maxReplayBytes`, rows/columns, and `attachRequestId`.
  - **Playwright validation (`PW-RUST`):** Parameterize every intent with unique request IDs, two sizes/priorities, and small replay budget; assert correlated replies/effective sequence, foreground size ownership, background nonresize, reconnect geometry, and bounded suffix plus gap notice.

- [ ] **TERM-08 — Emit explicit output-gap and stream-change events.** Report retention-window loss, replay-budget truncation, queue overflow, and server stream replacement instead of silently skipping bytes.
  - **Playwright validation (`PW-RUST`):** Generate numbered output beyond every boundary and assert reason/range/next sequence; then recover a fake runtime under the same terminal ID but a new `streamId`, assert `terminal.stream.changed`, checkpoint reset, and no mixed old/new sequence.

- [ ] **TERM-09 — Bound per-client output and handle slow clients.** Restore queue caps, visible-first pacing, background throttling, catastrophic slow-client closure, and bounded server memory.
  - **Playwright validation (`PW-RUST`, stress project):** Use `HARNESS-05`'s delaying proxy/raw socket to genuinely stop reads while another client consumes a large numbered stream; assert bounded RSS, fast-client completion, and slow-client gap/recovery or documented close. Simultaneously stream from foreground and background panes and assert the declared foreground latency target plus background send-rate/queue ceilings before and after swapping visibility.
  - PARTIAL (2026-07-18, commit 15b48427): queue caps (32MiB drop-oldest + gap-event coalescing, client-folded), catastrophic slow-client closure (4008, 16MiB/10s), bounded memory — implemented + real-socket tested. MISSING: visible-first pacing and background throttling (both depend on TERM-07 attach-priority, absent from the port); the stress-project PW validation; known narrow gap: a single indefinitely-blocked send with a quiet terminal escapes the catastrophic ticker (documented in backpressure.rs).

- [ ] **TERM-10 — Enforce terminal admission controls.** Restore per-connection creation throttling, the running-terminal cap, shutdown-time rejection, and canonical error responses.
  - **Playwright validation (`PW-RUST`):** Use raw and normal clients to burst creates past each limit, assert only the allowed number of fixture PIDs, visible/structured rate-limit errors, and successful creation after the window/cap clears; begin graceful shutdown and assert new creates are rejected.

- [ ] **TERM-11 — Enforce legacy detached-idle cleanup.** Apply `autoKillIdleMinutes` to eligible detached terminals while preserving active or attached terminals; legacy has no warning/countdown UI.
  - **Playwright validation (`PW-RUST`):** Use `HARNESS-14`, detach idle and active fixtures, keep one attached, advance past expiry, and assert only the eligible idle detached terminal exits and inventory/sidebar converge without an invented warning.

- [ ] **TERM-12 — Apply the legacy exited-record cap.** Remove oldest exited runtime records after the simple cap while never pruning running records; runtime terminal records are not expected to survive restart.
  - **Playwright validation (`PW-RUST`):** Create/exit more than a tiny configured cap, assert only the newest capped exited records plus all running records remain before restart, then restart and assert no false promise of persisted runtime records.

- [ ] **TERM-13 — Honor configured scrollback size.** Replace the fixed 8 MiB retention with the configured limit while preserving Unicode/frame boundaries and terminal search behavior.
  - **Playwright validation (`PW-RUST`):** Run the same numbered Unicode output under two scrollback settings, detach/reconnect, and assert the retained first/last markers and search results change at the intended boundary without corrupted characters.
  - PARTIAL (2026-07-18): `test/e2e-browser/specs/settings-live-reload.spec.ts` :: "a live PATCH of terminal.scrollback caps a terminal created AFTER it, surviving reattach" — proves the scrollback cap applies LIVE (via `PATCH /api/settings`, no restart) to a terminal created afterward, and the earliest output is correctly evicted after a detach/reattach; green both projects, 2x. This is explicitly "TERM-13-adjacent" (a live-apply/boot-only-snapshot fix, CFG-06 territory) rather than the item's own acceptance test. MISSING: only ONE scrollback setting is exercised (not two, so no boundary comparison), the flood content is plain ASCII (no Unicode-boundary-integrity proof), and terminal search-result behavior at the boundary is not asserted.

- [ ] **TERM-14 — Restore terminal metadata.** Publish git branch, dirty state, token usage, provider/model details, and other header/sidebar metadata; refresh it on relevant changes without polling storms.
  - **Playwright validation (`PW-RUST`):** Start in a fixture git repository, modify and commit a file, and have a fake agent report token usage; assert accessible header badges update from clean→dirty→clean and token values update in both tab and sidebar.

- [ ] **TERM-15 — Restore terminal-mode provider activity.** Implement Claude, Codex, OpenCode, and Amplifier activity-list responses and live updates, including reconnect seeding.
  - **Playwright validation (`PW-RUST`):** Record correlated raw list-response/update frames while driving each fake busy→idle, assert pane/tab/sidebar blue state matches those frames, reload during busy for reseeding, and verify no stale state after exit.

- [ ] **TERM-16 — Restore server-authoritative terminal completion where the provider exposes an authoritative signal.** Emit positive `terminal.turn.complete`, green attention, and one sound only for success; Gemini/Kimi remain status-inert until such a signal exists.
  - **Playwright validation (`PW-RUST`):** For signal-capable providers, assert raw completion frame plus one green/sound only on success—not error/interrupt/crash/idle—and dedupe after reconnect; assert Gemini/Kimi emit no false completion.

- [ ] **TERM-17 — Restore session association and generated-title broadcasts.** Emit `terminal.session.associated` and `terminal.title.updated` with monotonic/deduplicated identity.
  - **Playwright validation (`PW-RUST`):** Delay fixture identity/title events, assert the existing tab and sidebar update once when they arrive, then replay old/duplicate events and verify they cannot revert the newer identity/title.

- [x] **TERM-18 — Recover provider process loss.** Clear activity, mark the pane exited, preserve the durable identity, and lazily restart/recover where legacy does; never chime on a crash.
  - **Playwright validation (`PW-RUST`):** Kill the exact fake Claude/Codex/OpenCode child mid-turn, assert blue clears and an exited/retry state appears with no sound, click retry/send again, and verify the same durable session continues under one replacement process.
  - EVIDENCE (2026-07-18, commit <pending>): `test/e2e-browser/specs/restore-matrix.spec.ts` :: "a crashed Codex provider process is recovered mid-turn with no chime, and the same durable session continues" (scenario 6) now proves ALL of TERM-18, including "clear activity"/"assert blue clears": the busy/blue indicator (`resolvePaneActivity` -> `PaneHeader.tsx`'s `.pane-header-fresh-agent-identity`, scoped to the exact fresh-agent pane by `data-pane-id` since the tab is a split with a sibling shell pane) is proven ON via a positive control — seeding the SAME production Redux slot (`agentSession.status`, the real `freshAgent/setSessionStatus` action, the identical pattern already established in `pane-activity-indicator.spec.ts`) the live crash path is about to overwrite — then the REAL fixture-driven mid-turn crash (`exitProcessAfterMethodsOnce`) is asserted to have cleared it, alongside the pre-existing crash detection, no-chime, and durable-id-preservation assertions. (The crash's own `turn/start` response and process exit fire within the same JS tick with no observable in-browser gap, so the transient live busy state during THIS exact turn cannot itself be polled — confirmed by an earlier attempt that timed out waiting for it — hence the seeded positive control rather than a fabricated/looser "clears" check.) Green both projects, 2x full-spec runs (12/12 both times).

- [ ] **TERM-19 — Return errors for unknown or invalid terminal operations.** Do not silently ignore unknown attach/input/resize or falsely acknowledge detach; reject malformed messages consistently.
  - **Playwright validation (`PW-RUST`):** Send every invalid operation through `HARNESS-05`, assert the legacy-compatible error code/request correlation, and prove a normal terminal on the same connection remains usable when the error is nonfatal.

- [ ] **TERM-20 — Complete native Windows command quoting and path behavior.** Preserve arguments containing spaces, quotes, backticks, Unicode, hooks, model names, and WSL/Windows paths without shell reinterpretation.
  - **Playwright validation (`PW-RUST` native Windows):** Configure fixture providers and hooks in paths containing those characters, launch from the pane picker, and compare the fake executable's recorded argv/env byte-for-byte with the UI values; write/read files through both Windows and WSL path forms.

- [ ] **TERM-21 — Port viewport and paged-scrollback endpoints.** Retirement is allowed only after explicit product approval; parity work defaults to implementing both contracts.
  - **Playwright validation (`PW-RUST`):** Generate ANSI multi-page output, assert visible viewport/cursor metadata matches xterm, page scrollback forward/backward with stable nonoverlapping cursors/revisions, and verify invalid/stale/unknown requests match legacy responses.

- [ ] **TERM-22 — Incorporate current-main Codex lifecycle hardening.** Port startup-child reaping, ownership validation, sidecar cleanup, diagnostics, leak/OOM protection, and expected-restart behavior.
  - **Playwright validation (`PW-RUST`, stress project):** Repeat failed Codex startup, cancellation, crash, restart, and successful resume cycles; use `HARNESS-12` to assert no orphan sidecars, bounded RSS, one owner per thread, and no error toast/console noise during an expected restart. General server shutdown is owned by `SAFE-11`.
  - PARTIAL (2026-07-18): `crates/freshell-server/tests/safe11_term22_shutdown_reaping.rs` (commits edf1e93d, a8d43d9d) boots the real binary, creates a real PTY shell (`sleep 300`) plus a real fake-codex fresh-agent session, records every descendant pid, sends SIGTERM, and asserts exit within 5s with every descendant pid gone (zombie-aware), including hardening against a stale-pid group-kill sweeping an unrelated process; proven RED before the fix, green after (including sandboxed runs). MISSING: this is a Rust integration test, not a `PW-RUST`/stress-project Playwright spec — it does not cover failed-startup/cancellation/crash/resume cycles, `HARNESS-12` RSS/handle measurement, or an in-browser assertion of "no error toast/console noise during an expected restart" (that slice is `SYNC-05`, itself only partial).

- [ ] **TERM-23 — Complete the Codex candidate-persistence handshake.** Process `terminal.codex.candidate.persisted`, publish durability status, and promote a candidate identity only after the client has actually persisted it.
  - **Playwright validation (`PW-RUST`):** Have the fake Codex runtime announce a thread/rollout candidate, delay the client's acknowledgement and assert the server still treats it as provisional, then acknowledge, reload/restart, and assert the same durable thread is reused with one durability update.

- [ ] **TERM-24 — Implement the complete Codex input-blocking/recovery reason matrix.** Cover identity pending, capture timeout, identity unavailable, recovery pending, clean-exit decision pending, and lifecycle-loss pending without dropping or duplicating user input.
  - **Playwright validation (`PW-RUST`):** Script each reason, type a unique marker while blocked, assert the exact `terminal.input.blocked` reason and zero provider input, resolve/recover, and assert each accepted marker arrives exactly once or is explicitly returned for retry.

- [ ] **TERM-25 — Prevent wrong-thread Codex recovery.** Never render or silently adopt thread B while restoring expected thread A.
  - **Playwright validation (`PW-RUST`):** Have the fake report B during A restore, assert B output never appears, input stays blocked, expected/actual identity is reported, and only an explicit recovery choice can start fresh or reconnect A.

- [ ] **TERM-26 — Resolve the Rust server's native Windows home and terminal `~` correctly.** With no `HOME`/`FRESHELL_HOME`, use `%USERPROFILE%` for config/history and terminal cwd expansion.
  - **Playwright validation (`PW-RUST` native Windows):** Launch Rust with only isolated `USERPROFILE`, assert seeded config/history, create a terminal at `~/project/`, and assert the fake shell's cwd equals the isolated Windows profile project.

- [ ] **TERM-27 — Port Amplifier's hardened association, event-log, completion, and recency behavior.** Cover lazy first-prompt identity, spawn/prompt races, cwd ambiguity, EOF resume, partial/reset/schema-invalid logs, missed-watcher force-read, long turns without false completion, and sidecar-authoritative session recency.
  - **Playwright validation (`PW-RUST`):** Table-drive reversed spawn/prompt order, ambiguous cwd candidates, EOF then resume, partial/reset/invalid event files, and a deliberately missed watch event; assert one correct association after force-read, durable resume, useful diagnostics, and no wrong session. Run a long turn past the old heuristic and assert no false completion, then emit the sidecar event and assert exactly one completion plus the exact session recency update after reload.

## P0 — Rich-agent parity

- [ ] **AGENT-01 — Make create/send provider-neutral.** Support Claude, Kilroy, Codex, OpenCode, and configured future rich-agent providers through the same browser WebSocket and REST orchestration paths.
  - **Playwright validation (`PW-RUST`):** Create each provider from the UI and API, send the same deterministic prompt, and assert provider-specific fixtures receive it while the client observes the common event/status contract.

- [ ] **AGENT-02 — Implement attach/resume and reload hydration.** Reattach to live rich-agent sessions and hydrate durable sessions after browser/server restart without duplicating turns.
  - **Playwright validation (`PW-RUST`):** Send two turns, reload mid-third-turn, restart Rust after completion, and assert the same session ID, exactly three user/assistant turn pairs, resumed streaming, and no duplicate fixture process.
  - PARTIAL (2026-07-18): `restore-matrix.spec.ts` scenario 5 (commit 94a3ca94) proves same session id preserved across a real server restart, every post-restart create/attach targets the original session, and the resumed pane renders real non-blank content and returns to idle ("resumed streaming" in spirit) — green both projects. MISSING: the test's own "HONEST SCOPE NOTE" states the fake Codex app-server does not persist per-turn transcript content across a restart, so "exactly three user/assistant turn pairs" and "reload mid-third-turn" are explicitly NOT proven (only two full turns pre-restart + one restart, no mid-turn reload).

- [ ] **AGENT-03 — Implement interrupt and kill separately.** Interrupt stops only the active turn while preserving the session; kill ends the session and clears ownership.
  - **Playwright validation (`PW-RUST`):** Interrupt a scripted long turn and successfully send another in the same session, then kill it and assert future sends fail visibly until a new session is created; no completion sound may fire for either action.

- [ ] **AGENT-04 — Implement compact.** Forward compact requests, expose compacting status, preserve the durable session, and return to usable idle state.
  - **Playwright validation (`PW-RUST`):** Fill a fixture transcript, click Compact, assert the busy/compacting indicator and fixture request, then send another prompt and verify retained summary/context plus unchanged session identity.

- [ ] **AGENT-05 — Implement approval responses and cancellation.** Present pending tool approvals and support Allow, session-scoped Always Allow where applicable, and Deny with exact request correlation. A provider cancellation must remove the pending card without inventing a user decision.
  - **Playwright validation (`PW-RUST`):** Pause after the fake emits each approval and assert it has received zero decisions before a click; exercise every accessible action, assert the exact correlated payload and that denial does not run the tool, reload while pending to prove one restored request, then emit `freshAgent.permission.cancelled` and assert the card disappears with zero response.

- [ ] **AGENT-06 — Implement question responses.** Render provider questions, validate single-choice, multi-select, and Other/free-text answers, and resume the correct turn.
  - **Playwright validation (`PW-RUST`):** Answer single-choice, multiple-choice, and Other/free-text fixture questions through keyboard-accessible forms, assert the provider receives the exact correlated answers, and verify a validation error cannot submit or resume the wrong turn.

- [ ] **AGENT-07 — Implement session fork.** Fork from the selected turn/checkpoint with a new durable identity while leaving the source conversation unchanged.
  - **Playwright validation (`PW-RUST`):** Fork after a known second turn, assert source and child tabs diverge only after the fork point, reload/restart, and verify both resume their distinct fixture IDs and transcripts.

- [ ] **AGENT-08 — Preserve OpenCode continuity.** Stop creating a new OpenCode durable session on every REST `send-keys`; reuse the pane's existing identity until explicit fork/new-session.
  - **Playwright validation (`PW-RUST`):** Send three prompts through REST/MCP to one OpenCode pane and assert one durable ID and cumulative context; create a second pane and assert it receives a different ID.
  - PARTIAL (2026-07-18): `test/e2e-browser/specs/agent-continuity-matrix.spec.ts` :: "one durable OpenCode id persists across three REST send-keys calls; a second pane gets a different id" — three REST `send-keys` calls to one pane return the SAME `sessionId`, a second pane gets a DIFFERENT id; green both projects. MISSING: the spec's own comment states it "asserts the durable-id evidence directly" and does not itself assert cumulative context (accumulated prompt/message history in the fake OpenCode store) — that clause remains unproven by this test.

- [ ] **AGENT-09 — Implement transcript snapshot and paged-turn APIs.** Return stable thread metadata, revisioned turn pages, and unambiguous individual turn bodies for every provider.
  - **Playwright validation (`PW-RUST`):** Seed more than one page with duplicate display IDs and large tool bodies; open/reload/scroll backward and assert exact ordering and lazy body loading. Table-drive invalid cursor, revision mismatch, missing/ambiguous turn, cancellation, and body-size pagination, asserting the documented response and no stale page replacing the current transcript.

- [ ] **AGENT-10 — Implement model capabilities and refresh.** Expose provider/model capability metadata, cache it correctly, and allow refresh without restarting the server.
  - **Playwright validation (`PW-RUST`):** Have the fixture change its model list between requests, open the model picker, click Refresh, and assert additions/removals plus capability-driven controls update while the selected compatible model remains stable.

- [ ] **AGENT-11 — Implement file/image attachments.** Upload supported files with exact size/type limits, sanitized names, isolated storage, preserved history metadata, and provider-compatible payloads.
  - **Playwright validation (`PW-RUST`):** Attach a small image and text file, assert previews and exact fixture hashes, sanitized stored names below the isolated attachment directory, and transcript metadata after reload. Test the byte immediately below/at/above the cap plus traversal names and unsupported types; assert accessible errors, no provider send, and no partial/outside file.

- [ ] **AGENT-12 — Apply per-send model, effort, sandbox, permission, and plugin choices.** Stop parsing and discarding controls. Persist/display the model through the durable turn schema; pass other choices in the provider payload without claiming legacy persistence unless a separate schema change is deliberately approved.
  - **Playwright validation (`PW-RUST`):** Change each control between two sends in one pane, assert the fixture receives the exact distinct payloads, and verify model metadata survives transcript reload. Assert only fields defined by the durable schema persist; any broader persistence must have its own migration test.

- [ ] **AGENT-13 — Implement the legacy command-execution and diff APIs.** Run in any existing working directory, return the bounded buffered stdout/stderr/exit result, and render exact diffs with legacy-compatible errors. Streaming and child cancellation are separate product changes, not parity requirements.
  - **Playwright validation (`PW-RUST`):** Execute successful, nonzero, missing-cwd, and oversized-output fixture commands from the rich-agent UI and assert the complete bounded result; request a known diff and compare visible lines. Use only disposable directories while proving an existing cwd outside `allowedFilePaths` still matches the legacy contract.

- [ ] **AGENT-14 — Implement checkpoint create/list/metadata/restore.** Preserve provider/session ownership and restore tracked filesystem state safely; the conversation is explicitly unaffected.
  - **Playwright validation (`PW-RUST`):** Create a checkpoint, modify tracked fixture files and send another turn, restore through the UI, and assert file contents rewind while the later conversation turn, model state, and durable session identity remain unchanged after restart.
  - PARTIAL (2026-07-18): commit `96e354ea` ports the remaining list/restore/metadata routes (`GET .../checkpoints`, `POST .../checkpoints/restore`) onto the existing create-only endpoint, with 41 Rust tests covering format validation, list ordering/metadata decoration, restore's tracked-revert/untracked-preservation/deleted-file-recreation semantics, auth/400/404 error parity, and an end-to-end real-HTTP-route test (create→list→mutate→restore→verify bytes). MISSING (self-declared by this task's own evidence note): the UI rewind flow is NOT e2e-proven — no `PW-RUST` spec drives Restore through the actual UI, nor asserts the later conversation turn/model state/durable session identity remain unchanged after a restart.

- [ ] **AGENT-15 — Inject Freshell MCP tools into rich Claude and other supported providers.** Preserve tool discovery and route tool calls to the same provider-neutral orchestration layer.
  - **Playwright validation (`PW-RUST`):** Ask each fake provider to invoke a harmless `list_tabs` then `capture_pane` tool, assert tool cards/results in the transcript and exact API effects, and verify tools cannot access a different test server/session.

- [ ] **AGENT-16 — Scope subscriptions and events per client/session route.** Authorize attach and send, retain authorization across reconnect, and isolate OpenCode sessions by both durable ID and cwd route rather than broadcasting rich-agent content globally.
  - **Playwright validation (`PW-RUST`):** Open two contexts on different sessions, explicitly attach one, force its reconnect, and assert only authorized unique markers arrive. Attempt an unauthorized attach/send, then create identical OpenCode IDs under two cwd routes and prove neither route can observe or control the other.

- [ ] **AGENT-17 — Recover crashed sidecars and clear stale live records.** Remove dead runtime entries, emit exited status, preserve recoverable durable identity, and respawn lazily.
  - **Playwright validation (`PW-RUST`):** Kill each exact fixture sidecar mid-turn, assert the pane exits without green/sound, send Retry, and verify a replacement process resumes the same durable session with no duplicate live record.

- [ ] **AGENT-18 — Preserve server-authoritative waiting/completion semantics.** Deduplicate monotonic waiting and successful-completion edges across resume/restart.
  - **Playwright validation (`PW-RUST`):** Record raw waiting/completion frames while replaying duplicate/out-of-order fixture edges around a server restart; assert one waiting indicator, one completion indicator/sound for success, and no poisoning between the two event namespaces.

- [ ] **AGENT-19 — Implement the complete rich-agent error contract.** Map invalid cursor/display ID, revision mismatch, ambiguous/missing turn, unavailable runtime, unsupported capability, lost session, locator mismatch, and malformed provider output to stable 400/404/409/502/503 responses and recoverable UI state.
  - **Playwright validation (`PW-RUST`):** Table-drive every error through UI and raw API/WS helpers, assert exact status/code/correlation and a cleared spinner, then perform a valid action on the same pane to prove recovery and no accidental session/process creation.

- [ ] **AGENT-20 — Implement standalone `/api/fresh-agent/send`.** Address an existing durable session, return its `submittedTurnId`, and never create a second conversation as a side effect.
  - **Playwright validation (`PW-RUST`):** Create one session, send through the endpoint by its locator, assert the response turn ID matches the single new visible/provider turn and the durable ID/process count is unchanged; test missing, ambiguous, lost, and wrong-provider locators.

- [ ] **AGENT-21 — Make rich-agent create, fork, and send retries idempotent.** Deduplicate request IDs across delayed responses and reconnect. Define duplicate send as returning the original submitted turn rather than submitting its body twice.
  - **Playwright validation (`PW-RUST`):** Delay each first response, reconnect and retry the identical request from one and two clients, then assert one session/process, one fork, and one submitted prompt/turn ID. Reusing an ID with a different payload must return a conflict without mutation.

- [ ] **AGENT-22 — Materialize OpenCode placeholder identities exactly once.** Replace the provisional ID everywhere, emit one `freshAgent.session.materialized` and one effective `sessions.changed`, and share the final identity across UI, REST, and MCP.
  - **Playwright validation (`PW-RUST`):** Pause before the fixture returns its durable ID, observe the placeholder, release and record raw frames; assert one materialization/change, no placeholder remains in DOM/layout/API/MCP, and reload/restart resumes the final session without another event.

- [ ] **AGENT-23 — Isolate OpenCode process and cwd routing.** Reuse one long-lived `opencode serve` process while keeping pane sessions distinct; a session locator is the durable ID plus its cwd route.
  - **Playwright validation (`PW-RUST`):** Create two panes in different cwd roots, assert one serve PID and two session IDs, then inject the same durable ID into both route fixtures and prove sends, events, transcript reads, and permissions cannot cross roots.

- [ ] **AGENT-24 — Complete Kilroy rich-agent parity.** Implement create, attach/resume, send, approvals, questions, waiting/completion, reload/restart hydration, and crash recovery against its independent availability requirements.
  - **Playwright validation (`PW-RUST`):** Drive the full deterministic Kilroy fixture through each lifecycle edge, assert exact raw events and accessible UI, restart mid-session and crash mid-turn, and prove the same durable session recovers without a false completion or dependence on Gemini-summary availability.

- [ ] **AGENT-25 — Gate every rich-agent action by the registered provider capability matrix.** Generate provider/action expectations for interrupt, kill, compact, fork, approvals, questions, model refresh, attachments, per-send choices, and other `AGENT-03` through `AGENT-12` behavior; supported and unsupported paths must both be explicit.
  - **Playwright validation (`PW-RUST`):** Generate the matrix from registered provider capability metadata, invoke every action for every provider through the visible UI and API, and assert the fixture receives each supported operation while unsupported cells expose a stable disabled state or capability error with no request/process mutation. Fail if a provider/action registration lacks a scenario.

## P1 — Tab, pane, CLI, and MCP automation

- [ ] **AUTO-01 — Make `ui.layout.sync` authoritative.** Replace the OpenCode-only shadow layout with the real connected UI layout shared by browser, REST, CLI, and MCP. Reverse mutations are owned by `AUTO-02` through `AUTO-11`.
  - **Playwright validation (`PW-RUST`):** Create, rename, reorder, select, split, resize, and close content only through the visible UI, then fetch the layout snapshot and assert exact tab IDs/order, pane tree/ratios, titles, content, active tab, and active pane.

- [ ] **AUTO-02 — Complete provider-neutral tab creation.** Create shell, every terminal provider, browser, editor, and every rich-agent tab with cwd/model/effort/url/file options and atomic rollback on failure.
  - **Playwright validation (`PW-RUST`):** Parameterize `POST /api/tabs` over every content type, assert the resulting visible pane and fixture invocation, and force each launcher to fail once to prove no empty tab, live record, or child process remains.

- [ ] **AUTO-03 — Implement tab list, select, rename, delete, exists, next, and previous.** Preserve order, selection, title rules, and owned-resource cleanup.
  - **Playwright validation (`PW-RUST`):** Create three named tabs, invoke every route through `page.request`, and after each call assert the response, highlighted tab, tab order, and active layout agree; deleting a tab must reap only its owned resources.

- [ ] **AUTO-04 — Implement layout snapshot and pane listing.** Return the exact current layout with provider/session/terminal identities and the legacy tab-ID filter.
  - **Playwright validation (`PW-RUST`):** Build a nested three-pane layout containing terminal, browser, and rich-agent content; compare API JSON to visible hierarchy/bounding boxes, then filter by each tab ID and assert only that tab's panes are returned.

- [ ] **AUTO-05 — Implement pane split for every content type with rollback.** Support horizontal/vertical direction, position, ratio, provider parameters, browser URL, and editor file.
  - **Playwright validation (`PW-RUST`):** Parameterize both directions and all content types, assert pane count/order/ratio/content, then inject spawn/load failures and assert the original pane and process set are unchanged.

- [ ] **AUTO-06 — Implement pane rename, close, select, resize, swap, and respawn.** Preserve stable pane IDs where the legacy route contract requires them and clean up resources. Client-side content replacement is synchronized through `AUTO-01`; do not invent a pane-replace REST route.
  - **Playwright validation (`PW-RUST`):** Exercise every route on a two-then-three-pane layout, asserting accessible headers, active outline, measured bounding-box ratios, content exchange where supported, stable IDs as appropriate, and exact child-process cleanup; replace content through the visible UI and assert the authoritative layout sync.

- [ ] **AUTO-07 — Implement attach-existing-terminal with identity checks.** Attach buffered live terminals to empty panes without creating a second PTY.
  - **Playwright validation (`PW-RUST`):** Create/detach a terminal with known output, attach it through REST, and assert replay plus one PID; retry with a mismatched expected session and assert HTTP conflict, unchanged pane, and no leaked output.

- [ ] **AUTO-08 — Implement browser-pane navigation.** Navigate the intended pane while retaining its ID, layout, forwarding state, and history rules.
  - **Playwright validation (`PW-RUST`):** Host two deterministic pages, navigate by API, and assert the embedded marker changes while sibling panes, active selection, and pane ID remain stable; invalid/nonbrowser targets must return the documented error.

- [ ] **AUTO-09 — Implement pane send and capture with type-correct semantics.** Send text/control sequences to terminal panes, plain prompts to rich agents, and keep Editor capture-only; unsupported Browser/editor input and Browser capture must be explicit.
  - **Playwright validation (`PW-RUST`):** Assert exact terminal fixture bytes and one rich-agent prompt, capture ANSI terminal, editor, and rich transcript content in order, then attempt every unsupported pane/operation pair and verify a stable error with no mutation.

- [ ] **AUTO-10 — Implement wait-for.** Support text/regex, prompt, exit, rich-agent idle/waiting, timeout, and cancellation without matching another pane.
  - **Playwright validation (`PW-RUST`):** Script delayed markers/states in two panes, start parameterized waits, and assert correct resolution, timeout, invalid-regex error, request cancellation, and pane isolation.

- [ ] **AUTO-11 — Implement legacy `/api/run`.** Always create a new tab/pane and support `command`, `title`/`name`, `mode`, `shell`, `cwd`, `capture`, `detached`, and `timeout`; do not claim existing-pane execution, arbitrary env/input, or a real exit status that legacy never returned.
  - **Playwright validation (`PW-RUST`):** Table-drive every accepted field plus timeout/spawn failure, assert one new visible tab/pane with the exact fixture invocation and legacy response/capture shape, and prove failure leaves no empty tab or orphan.

- [ ] **AUTO-12 — Restore the legacy `codingcli.create/input/kill` WebSocket API.** Route it through the provider registry and preserve correlated events/errors for existing integrations.
  - **Playwright validation (`PW-RUST`):** Drive create/input/natural-exit/kill for a fake generic provider using `HARNESS-05`, assert the complete ordered frame contract and process cleanup, then send an unsupported provider and assert an explicit error rather than silence.

- [ ] **AUTO-13 — Complete every registered Freshell MCP command against Rust.** Generate the acceptance inventory from the actual registered tool definitions so a new or renamed command cannot escape coverage.
  - **Playwright validation (`PW-RUST`):** Generate a table from the registered MCP definitions, have a deterministic fake agent call every row against a visible layout, and assert tool result plus DOM/API/process effect; include enough sessions for every cursor and fail if any definition has no scenario.

- [ ] **AUTO-14 — Target automation and screenshots to the correct client window.** Track the authoritative layout source and never accept the first unrelated screenshot reply.
  - **Playwright validation (`PW-RUST`):** Open two contexts with unique visible markers and disjoint panes, request select/rename/screenshot for a pane present only in B, and assert only B changes and the returned image contains B's marker but not A's.

- [ ] **AUTO-15 — Implement tab/device conflict and retirement semantics.** On the durable store owned by `CFG-08`, implement idempotent retries, revision conflicts, stale-write rejection, tombstones, TTLs, and record/size caps.
  - **Playwright validation (`PW-RUST`):** Push/retry/conflict/stale/retire snapshots from two device contexts, advance `HARNESS-14`, and assert exact accept/reject revisions, expiry, nonresurrection, and survival of the last valid snapshot after an oversized write; restart persistence itself is gated by `CFG-08`.

## P1 — Extensions

- [ ] **EXT-01 — Port the complete strict manifest schema.** Validate client/server/CLI category requirements, defaults, timeouts, capabilities, content schema, icons, commands, create/resume identity, models, sandbox, permissions, and unknown fields.
  - **Playwright validation (`PW-RUST`):** Seed one valid manifest per category plus one specimen for every invalid class; assert only valid extensions appear, every registry field matches the fixture, and invalid manifests produce useful diagnostics without crashing discovery.

- [ ] **EXT-02 — Match discovery roots, precedence, duplicates, and symlink safety.** Cover built-in, user, and project extensions with deterministic first-wins behavior.
  - **Playwright validation (`PW-RUST`):** Seed duplicate names and symlinked entries across all roots, open Extensions and the pane picker, and assert one expected winner per name with no path outside an allowed root exposed.

- [ ] **EXT-03 — Implement live manifest reload and registry broadcasts.** Create/edit/invalidate/restore/delete manifests without restarting Rust or disturbing unaffected panes.
  - **Playwright validation (`PW-RUST`):** Mutate fixture manifests while two pages are open, assert cards and picker entries update once per effective change, invalid edits show an error, and an unrelated running extension pane/process remains stable.

- [ ] **EXT-04 — Implement enable/disable, discovery migration, and extension-scoped settings.** Persist typed string/number/boolean/path values and update launch availability immediately. Newly discovered CLI extensions follow legacy auto-enable rules, but an explicit user-disabled choice always wins.
  - **Playwright validation (`PW-RUST`):** Toggle each category and edit every field type, assert picker visibility and fixture payloads, reload/restart, and verify invalid values never launch. Add a new CLI manifest and assert initial auto-enable, disable it, invalidate/restore the manifest, and prove the disabled choice is preserved.

- [ ] **EXT-05 — Complete CLI-extension launch and permission mappings.** Honor command override, args/env/cwd, model, sandbox, `permissionModeEnvVar`, `permissionModeValues`, terminal behavior, and fresh/resume identity.
  - **Playwright validation (`PW-RUST`, native Windows quoting case):** Launch fresh and resumed panes with spaces/quotes/Unicode, compare the fake executable's argv/env exactly, and assert disabled or unsupported modes cannot launch.

- [ ] **EXT-06 — Serve client-extension HTML, scripts, assets, icons, and nested routes.** Provide correct content types, authentication, fallbacks, and traversal protection.
  - **Playwright validation (`PW-RUST`):** Open a real fixture extension pane, use `frameLocator` to navigate a nested route, interact with a form, load script/image/icon assets, and assert missing/traversal/symlink requests fail safely with usable error UI.

- [ ] **EXT-07 — Implement server-extension start and shared readiness.** Allocate/interpolate ports and content defaults, honor cwd/env/args, health-gate, and deduplicate concurrent starts.
  - **Playwright validation (`PW-RUST`):** Open the same server extension in two panes concurrently, assert one child/port and two loaded frames, and compare the fixture's received environment with the configured values.

- [ ] **EXT-08 — Implement server-extension failure, retry, crash, live status, and stop.** Publish `starting/ready/error/stopped`, clean failed children, and stop only the requested extension.
  - **Playwright validation (`PW-RUST`):** Exercise missing executable, readiness timeout, bad health, post-ready crash, successful retry, targeted stop, and server shutdown; assert status/UI transitions and exact process cleanup after each.

- [ ] **EXT-09 — Secure extension routes and process launch.** Enforce authentication, category, names, paths, body limits, and command boundaries.
  - **Playwright validation (`PW-RUST`):** Send wrong-auth, traversal, absolute/symlink, invalid-name, wrong-category, and oversized/malformed requests; assert no outside file read, registry corruption, or unintended process start.

- [ ] **EXT-10 — Bring Amplifier's manifest, icon, and warning suppression from current `main`.** Provider launch/resume, activity, durability, and history remain owned by `TERM-*` and `SESSION-*`; this is their branded-extension umbrella gate.
  - **Playwright validation (`PW-RUST`):** Require the dependent Amplifier terminal/session scenarios, assert the built-in manifest and real icon appear in picker/history, and verify no `prompt_toolkit` CPR warning appears in the pane or logs.

## P1 — Browser panes, proxying, files, and editors

- [ ] **BROWSER-01 — Complete same-origin HTTP reverse proxying.** Preserve method/path/query/body/useful headers/status/streaming while removing only iframe-blocking headers.
  - **Playwright validation (`PW-RUST`):** Load a fixture that sets CSP/X-Frame-Options in a Browser pane, interact through `frameLocator`, issue GET/POST/streaming requests, and assert exact upstream inputs and visible responses.

- [ ] **BROWSER-02 — Implement WebSocket upgrade proxying.** Preserve query, subprotocol, cookie authentication, binary/text frames, and clean/error close behavior.
  - **Playwright validation (`PW-RUST`):** Load a proxied fixture page that opens a WebSocket, exchange text/binary messages and update the frame DOM, then stop upstream and assert a clear reconnectable pane error.

- [ ] **BROWSER-03 — Implement remote browser forwarding.** Create/reuse/delete owned forwarders for HTTPS and remote clients, enforce caps/idle cleanup, and preserve protocol/path/query.
  - **Playwright validation (`PW-RUST`):** From a non-loopback browser context, load the trusted HTTPS fixture through a returned forward, assert reuse for the same owner and isolation for another, hit the cap, close/idle panes, and verify exact forward/process/port cleanup.

- [ ] **BROWSER-04 — Restrict proxy destinations and requesters.** Allow only intended loopback targets and authenticated owners.
  - **Playwright validation (`PW-RUST`):** Try invalid ports, non-loopback targets, wrong auth, wrong owner, encoded targets, and unauthorized WebSocket upgrades; assert rejection and zero upstream connections while a valid request still works.

- [ ] **BROWSER-05 — Provide visible proxy failure/retry behavior and correct screenshot capture.** Never spin forever or capture an unrelated/opaque frame.
  - **Playwright validation (`PW-RUST`):** Navigate to an offline fixture, assert target-specific Retry UI, start it and recover without recreating the tab, then compare Freshell capture with Playwright's deterministic frame marker.

- [ ] **FILE-01 — Implement authenticated `/local-file`.** Support header or auth-cookie access with correct MIME/bytes and stable missing/directory/unreadable errors.
  - **Playwright validation (`PW-RUST`):** Open fixture HTML, image, Unicode, binary, and large files from `file://` Browser-pane entries; test good/bad/no credentials and assert only authenticated bytes render.

- [ ] **FILE-02 — Preserve Windows drive and UNC file URLs.** Decode `file:///C:/...` and `file://server/share/...` exactly once without losing the drive/host.
  - **Playwright validation (`PW-TAURI-WIN`):** Enter the drive URL and a real temporary `HARNESS-06` SMB-share URL with spaces/Unicode in the Browser address bar; assert each frame loads the intended bytes and never a similarly prefixed neighbor, then remove the share and assert a bounded recoverable error.

- [ ] **FILE-03 — Complete POSIX, Windows, WSL, and UNC path normalization.** Cover `~`, relative roots, separators, case-folding, `C:\`, `/mnt/c`, `/home`, `\\wsl$`, and network shares.
  - **Playwright validation (`PW-RUST` Linux/WSL/native Windows projects):** Parameterize read/stat/write/complete/mkdir/open against paired fixtures and assert the exact intended file changes, with no prefix-confusion or cross-root access. In a native Windows VM with no WSL distro, a POSIX path must fail promptly with guidance and must not invoke `wsl.exe` or the Windows Store.

- [ ] **FILE-04 — Implement `/api/files/open` and external editor/reveal.** Honor default/configured/custom editor, line/column, reveal, quoting, and failure reporting.
  - **Playwright validation (`PW-RUST`, `PW-TAURI-WIN`):** Click Open Externally in an Editor pane, assert the fake opener's exact argv for every mode/path, and simulate spawn failure to prove a visible error and no success claim.

- [ ] **FILE-05 — Apply `allowedFilePaths` live to every file surface.** Use one canonical authorization rule for read/write/stat/complete/mkdir/open/local-file/editor.
  - **Playwright validation (`PW-RUST`):** Allow one fixture root, test every operation inside/outside, change the setting without restart, and repeat; assert new policy is immediate and consistent.

- [ ] **FILE-06 — Prevent traversal, symlink, and case-fold escapes.** Reject encoded `..`, absolute escapes, symlinks outside roots, and prefix-confusion directories.
  - **Playwright validation (`PW-RUST`, native Windows case project):** Attempt every escape through each file endpoint and visible UI action; assert the outside sentinel remains unread/unmodified and no external editor/process starts.

## P1 — Network management

- [ ] **NET-01 — Return complete, live network status.** Include actual bind, configured intent, LAN addresses/hostname, reachability, platform/firewall/forwarding state, stale managed rules, in-progress state, and share URL.
  - **Playwright validation (`PW-RUST`, `PW-TAURI-WIN`):** Change fixture network/firewall facts while Settings remains open and assert every field updates without stale caching. In one disposable Windows VM, compare the returned adapters, listeners, bind address, and managed firewall state with actual host observations from `HARNESS-09`.

- [ ] **NET-02 — Implement transactional configure/rebind.** Toggle loopback/LAN binding and update persistence only after the new listener is proven.
  - **Playwright validation (`PW-RUST`):** Enable remote access and connect from the fixture LAN address, disable it and assert LAN fails while loopback remains; occupy the target address to force failure and verify the old listener/config remain usable until retry succeeds.

- [ ] **NET-03 — Generate and copy an accurate share URL safely.** Include protocol/host/port and percent-encoded token without logging the secret.
  - **Playwright validation (`PW-TAURI-WIN`):** Copy the URL from Settings/quick access, open it in a fresh context and authenticate, then scan retained browser/server/desktop logs to assert the raw token was not logged.

- [ ] **NET-04 — Implement Windows firewall configure/repair with confirmation.** Use one-time action-bound tokens, an in-progress lock, exact managed rule names, and post-operation verification.
  - **Playwright validation (`PW-TAURI-WIN`, disposable elevated VM):** Cancel once and assert no OS call, confirm once and assert exact rule/port creation, replay/concurrently reuse the token and assert rejection, then repair stale Freshell rules while an unrelated sentinel rule survives.

- [ ] **NET-05 — Implement WSL2 forwarding without WSLg.** Keep the client native Windows while creating/verifying only Freshell-owned portproxy/firewall state for a WSL server.
  - **Playwright validation (`PW-TAURI-WIN` + WSL fixture):** Enable exposure, verify the recorded plan and connect through the Windows LAN address, then disable and assert managed forwards/rules disappear while the native client and unrelated rules remain.

- [ ] **NET-06 — Implement safe disable of remote access.** Rebind loopback and remove only verified Freshell-managed exposure; do not claim completion before verification.
  - **Playwright validation (`PW-TAURI-WIN`):** Start with managed exposure, disable through accessible confirmation, assert LAN is unreachable/loopback works/config persisted, and confirm unrelated rule/forward sentinels survive.

- [ ] **NET-07 — Handle elevation denial, timeout, partial success, and verification failure.** Reconcile with a fresh status read and give useful retry/repair choices.
  - **Playwright validation (`PW-TAURI-WIN` fault fixture):** Return each failure result, assert accurate nonstuck UI and no false saved state, then switch fixture to success and verify retry completes.

- [ ] **NET-08 — Secure every network mutation.** Reject missing auth, unknown/malformed fields, arbitrary hosts, command injection, token replay, and overlapping privileged operations.
  - **Playwright validation (`PW-RUST`):** Send a negative request matrix through `page.request`, assert zero OS-fixture calls and unchanged config/listeners, then prove one valid request still succeeds.

- [ ] **NET-09 — Keep network writes lossless.** Route network changes through the same serialized config store.
  - **Playwright validation (`PW-RUST`):** Seed every config sentinel, toggle remote access and restart, and assert chosen network behavior plus byte-preserved unrelated sections.

- [ ] **NET-10 — Preserve native Linux network status and setup guidance.** Report native Linux addresses/listeners and the legacy terminal/`ufw` guidance without executing privileged commands automatically; macOS must either receive equivalent supported behavior or be declared outside the release boundary.
  - **Playwright validation (`PW-RUST` native Linux):** Compare live status with an isolated network namespace, request LAN setup, assert exact copyable commands and zero privileged process invocation, apply the commands in the disposable namespace, refresh, and verify reachability/status; assert the documented macOS support boundary in the UI when applicable.

## P1 — Diagnostics, logging, AI, and bootstrap

- [ ] **DIAG-01 — Implement structured JSONL Rust server and Tauri logs.** Include timestamp, severity, component/event, request/connection/process ownership, app version, and lifecycle context.
  - **Playwright validation (`PW-RUST`, `PW-TAURI-WIN`):** Perform auth, terminal, provider, recoverable error, restart, and quit flows; parse every log line and assert required fields and coherent correlation IDs.
  - PARTIAL (2026-07-18): commit `d5a526d3` adds `crates/freshell-server/src/logging.rs` (a hand-rolled `tracing_subscriber` Layer emitting one JSONL line per event with ts/level/target/msg + request_id/route/method/status/duration_ms) and a Rust integration test `crates/freshell-server/tests/diag01_diag03_logging.rs`. MISSING (self-declared in the commit's own scope note): only the HTTP request lifecycle is covered — WS connect/disconnect+reason and terminal/fresh-agent lifecycle event wiring (in freshell-ws/freshell-terminal/freshell-freshagent) are explicitly deferred; also not a `PW-RUST`/`PW-TAURI-WIN` Playwright spec exercising real auth/terminal/provider/restart/quit flows through the browser.

- [ ] **DIAG-02 — Persist client logs instead of discarding them.** Preserve severity, structured context, and stack within bounds.
  - **Playwright validation (`PW-RUST`):** Emit console debug/info/warn/error and an unhandled page error, assert matching structured server log entries, and send malformed/oversized batches to verify 400/bounding without a crash.

- [ ] **DIAG-03 — Redact secrets and rotate logs safely.** Cover URL/header/body/nested error tokens, concurrent writers, rotation count, and final flush.
  - **Playwright validation (`PW-RUST`, `PW-TAURI-WIN`):** Generate small-limit rotation with secret sentinels, parse all rotated files, assert chronological coverage/valid JSON/no raw secret, and confirm the final shutdown event is flushed.
  - PARTIAL (2026-07-18): commit `d5a526d3`'s `logging.rs` implements size-based rotation (10MB x 2 backups, overridable) and from-the-first-byte redaction (AUTH_TOKEN value, any `*token*`-keyed JSON field, `cookie`), verified by the same `diag01_diag03_logging.rs` Rust integration test. MISSING: not a `PW-RUST`/`PW-TAURI-WIN` Playwright spec — no small-limit-rotation-with-secret-sentinels scenario driven through the browser, and concurrent-writer/final-shutdown-flush behavior is not asserted at that layer.

- [ ] **DIAG-04 — Wire live debug and performance logging toggles.** Start/stop debug events, sampling timers, and reconnect state without restart.
  - **Playwright validation (`PW-RUST`):** Perform the same action before/during/after toggling Debug logging, assert detailed/perf entries only during enabled interval, reload/restart, and verify the saved state and stopped timers.

- [ ] **DIAG-05 — Implement `/api/debug`, `/api/perf`, and `/api/server-info`.** Return accurate sanitized runtime data and live control responses using schema-based secret redaction.
  - **Playwright validation (`PW-RUST`):** Create known clients/tabs/terminals/indexed projects, compare counts/version/uptime/platform, toggle perf, and seed `ai.geminiApiKey`, provider credentials, saved remote tokens, auth headers, nested secrets, and an unknown future secret-marked field. Assert no credential, prompt, or unrelated filesystem secret appears.

- [ ] **DIAG-06 — Implement terminal summaries with heuristic fallback and optional AI.** Report accurate summary-AI and Kilroy availability independently; full Kilroy behavior is owned by `AGENT-24`.
  - **Playwright validation (`PW-RUST`):** Summarize known output without credentials and assert bounded heuristic source; enable the fake summary AI and assert deterministic AI source, then test timeout/500/malformed/empty responses and assert fallback/no stuck spinner. Independently toggle Kilroy's own prerequisites and assert its picker availability changes without falsely depending on summary AI.

- [ ] **DIAG-07 — Make bootstrap truthful and bounded.** Include `configFallback`, `legacyLocalSettingsSeed`, actual startup-task status, perf state, payload budget, scheduling, and cancellation.
  - **Playwright validation (`PW-RUST`):** Hold index/repair behind barriers, launch and assert incomplete status/fallback/seed, release and observe readiness, then seed oversized data and abort a slow bootstrap request while health and terminal input stay responsive.

- [ ] **DIAG-08 — Synchronize runtime version identity.** Report one version across Cargo, server API, Tauri, installer, updater, filenames, and logs.
  - **Playwright validation (`PW-RUST`, `PW-TAURI-WIN` packaged):** Collect every reported/installed version and assert exact equality to the build's expected release version rather than the stale 0.7.0 value.

## P1 — Protocol, security, and reliability limits

- [ ] **SAFE-01 — Match token validation and authentication rules.** Reject empty, weak, default, malformed, and conflicting token sources while preserving header/cookie/query/WS behavior.
  - **Playwright validation (`PW-RUST`):** Launch parameterized bad-token configurations and assert startup/config errors, then test good/wrong/missing tokens through UI, API, local-file, proxy, and WebSocket without exposing the token in logs.
  - PARTIAL (2026-07-18): commit `1cb497ee` fixed `is_authed()` conflicting-source precedence to mirror legacy exactly (header wins unconditionally over cookie) and added `validate_auth_token()` rejecting empty/whitespace/too-short/default-value startup tokens, with unit/real-socket Rust tests (`crates/freshell-ws/tests/origin_policy.rs` and friends). MISSING: this is Rust crate-level testing, not a `PW-RUST` Playwright spec — no browser-driven parameterized bad-token startup assertion, and no UI/API/local-file/proxy/WS good-wrong-missing-token matrix.

- [ ] **SAFE-02 — Add the global authenticated API rate limit.** Return 429 and `Retry-After` with the intended client scope while leaving static UI/health available.
  - **Playwright validation (`PW-RUST`):** Start with a tiny limit, issue requests to the boundary and beyond from two contexts, assert scoping and 429 metadata, advance the test clock, and verify recovery.

- [ ] **SAFE-03 — Enforce WebSocket Origin policy.** Accept configured trusted origins and reject hostile/malformed origins before session state is exposed.
  - **Playwright validation (`PW-RUST`):** Open raw sockets with same-origin, allowed remote, missing, `null`, and hostile origins, assert documented accept/close behavior, and verify rejected clients receive no ready/settings/terminal data.
  - PARTIAL (2026-07-18): commit `1cb497ee` adds `crates/freshell-ws/src/origin.rs` enforcing an allow-list (intentionally stricter than legacy's advisory-only check) plus `crates/freshell-ws/tests/origin_policy.rs` (200 lines, incl. DNS-rebinding cases). MISSING: Rust-crate-level tests only, not a `PW-RUST` raw-socket spec driven from Playwright (HARNESS-05); the same-origin/allowed-remote/missing/`null`/hostile matrix and the "rejected clients receive no ready/settings/terminal data" assertion are unproven at the Playwright layer.

- [ ] **SAFE-04 — Enforce maximum authenticated WebSocket connections.** Release capacity promptly and preserve existing clients when the cap is reached.
  - **Playwright validation (`PW-RUST`):** Configure max two, authenticate two raw sockets, assert a third closes with the expected code, close one and assert a new connection succeeds while the remaining original continues terminal I/O.

- [ ] **SAFE-05 — Enforce hello timeout, JSON ping/pong, and transport heartbeat separately.** Reply to an application `{type:"ping"}` with the correlated JSON pong while WebSocket control-frame heartbeat independently closes dead peers; neither may kill a detached terminal.
  - **Playwright validation (`PW-RUST`):** Delay hello past/just before the deadline, send a JSON ping and assert the exact JSON pong, then independently suppress/respond to transport control pings through the controllable proxy. Assert only stale sockets close, subscriptions clean up, and a replacement page attaches to the surviving terminal.

- [ ] **SAFE-06 — Enforce inbound frame, body, outbound chunk, and bootstrap payload bounds.** Reject oversized data without unbounded memory or cross-client impact.
  - **Playwright validation (`PW-RUST`):** Send just-below/just-above-limit HTTP and WS payloads, flood one large output, assert correct rejection/close and exact chunk reassembly for allowed data, bounded RSS, and unaffected second-client health.
  - PARTIAL (2026-07-18, commit 15b48427): WS inbound frame/message bounds at legacy parity (16MiB default, WS_MAX_PAYLOAD_BYTES override) with real-socket rejection tests. MISSING: HTTP body + bootstrap payload bounds; outbound chunk reassembly assertions; the PW just-below/above matrix.

- [ ] **SAFE-07 — Implement the complete client-to-server protocol inventory.** Every valid declared message must produce its correct successful effect/response; explicit errors are reserved for invalid payloads or genuinely unsupported negotiated capabilities. `TERM-19` owns terminal-specific error semantics.
  - **Playwright validation (`PW-RUST`):** Generate a table from the reconciled current-main client-message schema, drive a valid minimum and negative payload for every variant, and require the exact success event/effect or exact error with request correlation. Fail when a schema row has no semantic scenario; follow every nonfatal negative case with a valid terminal command.

- [ ] **SAFE-08 — Implement client restore diagnostics and repair.** Record structured diagnostics, reconcile stale handles once, and prevent restore loops.
  - **Playwright validation (`PW-RUST`):** Seed dead/mismatched terminal and agent handles so the SPA reports diagnostics, assert one server repair/recreation and structured log, then reload and verify no repeated loop.

- [ ] **SAFE-09 — Cancel abandoned long-running requests.** Cover snapshot, wait-for, exec, provider start, search, and bootstrap work.
  - **Playwright validation (`PW-RUST`):** Start blocked fixture calls, abort/navigate away, assert fixture cancellation and task counts return to zero, then require a health request and terminal keystroke to complete promptly.

- [ ] **SAFE-10 — Make critical broadcast lag recoverable.** Resync settings, lifecycle, activity, association, materialization, extensions, and tabs instead of leaving a silently stale client.
  - **Playwright validation (`PW-RUST`):** Freeze one context with tiny channels while bursting each critical event family, resume, and assert a resync/snapshot makes its UI equal the authoritative API/second client with no ghost terminals or stale busy state.

- [ ] **SAFE-11 — Own graceful, ownership-safe Rust shutdown.** Stop accepting work, flush state/logs, terminate exact terminal/provider/extension trees, use the full grace period, and never touch unrelated processes. Provider-specific Codex cleanup remains a dependency of `TERM-22`.
  - **Playwright validation (`PW-RUST`, native Windows project):** Start every fixture plus an unrelated sentinel, stop the exact server, assert graceful events before forced escalation, all and only owned PIDs/ports disappear, and the final config/logs parse.

- [ ] **SAFE-12 — Add a bounded mixed-load soak.** Exercise multi-client terminals, agent events, tab sync, proxy traffic, indexing, API captures, and reconnects together.
  - **Playwright validation (`PW-RUST`, stress project):** Run the mixed scenario for 30 minutes in CI and two hours at the final release gate; assert every final marker in the correct pane, declared latency/RSS/handle/queue ceilings, no cross-session event leakage, clean recovery, and zero owned PIDs after teardown.

- [ ] **SAFE-13 — Implement and inventory every server-to-client event.** Give every reconciled current-main server-message schema variant a semantic owner, exact payload/correlation contract, reconnect behavior, and an approved retirement only if product management explicitly removes it.
  - **Playwright validation (`PW-RUST`):** Generate the coverage manifest directly from the reconciled schema and link every variant to a scenario that induces the real behavior, records the exact raw frame, and asserts its user-visible or client-state effect. Fail on an unowned type, a generic substitute event, wrong correlation, or a declared event that can never be produced.

## P1 — Native Windows Tauri startup and configuration

- [ ] **TAURI-01 — Resolve the native Windows Freshell home correctly.** Use `FRESHELL_HOME` when explicit, otherwise `%USERPROFILE%` when `HOME` is absent, and isolate WebView2/profile paths.
  - **Playwright validation (`PW-TAURI-WIN`):** Launch with only an isolated `USERPROFILE` containing settings/history and assert they load; relaunch with a different explicit `FRESHELL_HOME` and assert it wins, with no files created beside the executable or in the real profile.

- [ ] **TAURI-02 — Read and validate existing `desktop.json` on every cold start.** Honor mode, port, remote URL/token, known servers, chooser policy, hotkey, tray behavior, and window state without requiring provisioning variables.
  - **Playwright validation (`PW-TAURI-WIN`):** Parameterize valid app-bound/daemon/remote configs plus malformed JSON, unsupported version/type, invalid URL/port/hotkey, and unknown sentinels. Launch without provisioning variables; assert valid cold-start behavior, a usable backup/reset/edit recovery path for each invalid case, no partial launch, and lossless unknown fields after the next desktop save.

- [ ] **TAURI-03 — Implement the real startup state machine.** Route no config→wizard, configured target→main, forced/ambiguous/unavailable target→chooser, and daemon→service path with exactly one appropriate window.
  - **Playwright validation (`PW-TAURI-WIN`):** Run each input state, enumerate real WebView2 pages/native windows, and assert exact phase/window count and final authenticated main page after completing the flow.

- [ ] **TAURI-04 — Reuse configured app-bound port and legacy token with an explicit bootstrap-secret contract.** Resolve precedence from desktop config, `.env`, and legacy config. The percent-encoded token may exist only in the initial in-memory navigation URL; the client must authenticate, immediately scrub the query with `history.replaceState`, and prevent that bootstrap URL from entering retained traces/logs/history/screenshots.
  - **Playwright validation (`PW-TAURI-WIN`):** Give desktop config, `.env`, and legacy config different conflicting ports/tokens, table-drive their presence/absence, and assert the documented winner on two launches. Include `+&#` and spaces, wait for bootstrap and assert the visible/history URL is clean, then scan redacted retained artifacts/logs/persisted storage. A test-only launch recorder may confirm correct initial encoding but must not retain the raw value.

- [ ] **TAURI-05 — Handle configured-port collisions safely.** Detect whether the occupant is a compatible Freshell server and offer connect/change/retry without killing it or silently choosing a random port.
  - **Playwright validation (`PW-TAURI-WIN`):** Occupy the port with compatible and incompatible sentinel servers, assert the correct chooser/error actions, select each path, and prove the original process remains alive unless it was explicitly app-owned.

- [ ] **TAURI-06 — Resolve the packaged server binary robustly.** Support development and installed layouts, spaces/Unicode, and clear missing/permission errors without relying on environment overrides.
  - **Playwright validation (`PW-TAURI-WIN` packaged):** Install under a spaced/Unicode profile path, clear developer variables, launch and assert the child path lies inside installed resources; remove/deny it in fault fixtures and assert understandable startup UI plus no leaked process.

- [ ] **TAURI-07 — Capture and supervise child stdout/stderr.** Store structured diagnostics and expose a useful startup failure instead of discarding output.
  - **Playwright validation (`PW-TAURI-WIN`):** Launch a fixture server that prints distinct stdout/stderr then fails; assert both appear redacted in desktop logs, the visible error includes the safe reason, and the child is reaped.

## P1 — Tauri setup wizard and launch chooser

- [ ] **TAURI-08 — Build and wire the first-run setup wizard.** Support accessible app-bound, daemon, and remote setup with port/URL/token/hotkey validation and final confirmation.
  - **Playwright validation (`PW-TAURI-WIN`):** Drive every screen solely by roles/labels/keyboard, assert inline errors for invalid values, complete each mode, and verify `desktop.json` is written only at confirmation before exactly one authenticated main window replaces the wizard.

- [ ] **TAURI-09 — Scope wizard/chooser commands to trusted windows.** Reject calls from the main app, extension frames, or arbitrary origins.
  - **Playwright validation (`PW-TAURI-WIN`):** Invoke setup/choice commands from the real wizard and from hostile main/iframe contexts, asserting only the trusted source changes config or startup phase.

- [ ] **TAURI-10 — Build and wire the launch chooser.** List candidates, start local, enter remote, remember choices, and persist `alwaysAskOnLaunch` before transitioning cleanly.
  - **Playwright validation (`PW-TAURI-WIN`):** Seed forced choice and multiple candidates, exercise every action/checkbox, assert persisted policy and optional remembered server, and verify no chooser/main/server process duplicates.

- [ ] **TAURI-11 — Discover and deduplicate local/known servers.** Probe configured ports and remembered entries, retain useful offline candidates, and order them predictably.
  - **Playwright validation (`PW-TAURI-WIN`):** Run two healthy fixture servers, one duplicate known entry, and one offline entry; assert labels/status/order/deduplication and successful selection.

- [ ] **TAURI-12 — Resolve candidate tokens with explicit precedence and secrecy.** Cover saved remote/candidate data, `.env`, legacy config, and user entry.
  - **Playwright validation (`PW-TAURI-WIN`):** Give each source a different sentinel, select candidates, and assert the documented winner authenticates while chooser text, screenshots, and logs never reveal it.

- [ ] **TAURI-13 — Authenticate before opening main.** A successful health check alone must not accept a wrong token.
  - **Playwright validation (`PW-TAURI-WIN`):** Use a fixture with public health and rejecting settings endpoint, assert chooser remains with an auth error, correct the token, and assert transition to main.

- [ ] **TAURI-14 — Support HTTPS remotes.** Use TLS for health and authentication, handle trusted/untrusted certificates clearly, and never downgrade to HTTP.
  - **Playwright validation (`PW-TAURI-WIN`):** Connect to `HARNESS-06` trusted HTTPS and assert successful main load; repeat with an untrusted certificate and assert a clear chooser error plus zero plain-HTTP request.

- [ ] **TAURI-15 — Fall back to chooser for unavailable saved targets.** Keep the desktop alive with retry/change/start-local choices rather than aborting.
  - **Playwright validation (`PW-TAURI-WIN`):** Seed an offline remote, assert chooser and failed candidate, bring it online, click Retry, and verify one authenticated main window.

- [ ] **TAURI-16 — Make provisioning atomic, one-shot, and persistent.** Consume valid installer handoff once, preserve diagnostics for invalid/interrupted input, and use saved configuration on later cold starts.
  - **Playwright validation (`PW-TAURI-WIN` packaged):** Run valid, malformed, wrong-token, and interrupted cases; assert valid input is consumed once and works after all provisioning variables are removed, while invalid input cannot partially overwrite a working config.

## P1 — Tauri owned server and daemon lifecycle

- [ ] **TAURI-17 — Fix graceful app-bound shutdown.** Use the full grace interval, close the complete Windows process tree, flush state/logs, and escalate only the owned tree if necessary.
  - **Playwright validation (`PW-TAURI-WIN`):** Quit with a fixture child that exits after one second and assert graceful exit before five seconds; repeat with an ignoring child and assert force-kill occurs only after the full grace period while an unrelated sentinel survives.

- [ ] **TAURI-18 — Respect ownership by server mode.** Quit must stop app-bound children but never remote or daemon-owned servers.
  - **Playwright validation (`PW-TAURI-WIN`):** Quit one app in each mode and assert only app-bound health/PIDs disappear; remote/daemon fixtures remain reachable and reconnectable.

- [ ] **TAURI-19 — Implement Windows daemon install, start, stop, status, and uninstall through Task Scheduler.** Create one Freshell-owned scheduled task with safely quoted installed paths, a stable identity, noninteractive startup, and exact ownership checks.
  - **Playwright validation (`PW-TAURI-WIN-PACKAGED`, disposable elevated VM):** Complete daemon setup from the exact installed app, inspect the scheduled task/action/principal and confirm every path points to installed resources, quit UI and confirm the server remains, relaunch/reconnect, stop/start, uninstall, and assert task/process cleanup plus preserved unrelated tasks/services.

- [ ] **TAURI-20 — Handle daemon failure and stale registration.** Cover access denied, missing binary, stopped service, stale config, and repair/app-bound fallback.
  - **Playwright validation (`PW-TAURI-WIN` fault fixture):** Return each state, assert accurate wizard/chooser actions and no premature success, then repair/retry and reach main.

## P1 — Tauri window, tray, shortcut, menu, and recovery

- [ ] **TAURI-21 — Implement `minimizeToTray`.** Native close hides when enabled and exits when disabled; restoring uses the same page/state.
  - **Playwright validation (`PW-TAURI-WIN-PACKAGED`):** Use Windows UI Automation to click the exact shipped native close button in both configurations, assert hidden/visible/process/server state, invoke the real tray Show action, reconnect CDP if needed, and verify the same tabs remain. No control-plane close simulation satisfies this item.

- [ ] **TAURI-22 — Complete live tray behavior.** Show/Hide, running state, mode, Settings, Check for Updates, and Quit must reflect current state and invoke real handlers.
  - **Playwright validation (`PW-TAURI-WIN`, `PW-TAURI-WIN-PACKAGED`):** In the instrumented build, inspect state/invoke every production handler, crash/restart the child, and assert live updates. In separate exact-package launches, use `HARNESS-13` to open the real Windows tray menu and invoke every command—Show, Hide, Settings, Check for Updates, and Quit—while asserting live status/mode labels and each shipped effect without the control plane.

- [ ] **TAURI-23 — Honor and safely change the saved global shortcut.** Unregister old keys, register new keys, retain the old working key on conflict, and show a useful error.
  - **Playwright validation (`PW-TAURI-WIN`):** Seed a nondefault shortcut, send it at OS level and assert show/hide, change it and test old/new behavior, then simulate conflict and assert rollback plus visible error.

- [ ] **TAURI-24 — Implement `startOnLogin` as explicit new product work.** The legacy control was unimplemented; the Tauri version uses one per-user Windows Task Scheduler entry that launches the installed desktop app after sign-in.
  - **Playwright validation (`PW-TAURI-WIN-PACKAGED`):** Enable/disable repeatedly and inspect one safely quoted per-user task, simulate sign-in in a disposable VM and assert one app launch, apply an update and retest, then disable and prove the task is removed without touching unrelated startup entries.

- [ ] **TAURI-25 — Complete window-state persistence and concurrency.** Preserve position, logical size, maximize, DPI, monitor removal, on-screen clamping, and unrelated desktop config keys.
  - **Playwright validation (`PW-TAURI-WIN`):** Move/resize/maximize, race with another desktop setting, relaunch and compare bounds within DPI tolerance; seed offscreen/removed-monitor bounds and assert the window returns onscreen with valid merged JSON.

- [ ] **TAURI-26 — Finish single-instance focus behavior.** A second launch must focus/show the first and never spawn another server.
  - **Playwright validation (`PW-TAURI-WIN`):** Launch, hide/minimize, launch again, and assert first window visible/focused, one Tauri/server tree, and prompt second-process exit.

- [ ] **TAURI-27 — Add the desktop application menu.** Include Edit, View, Window, Help/About, Preferences, update, reload, zoom, fullscreen, and appropriate development tools.
  - **Playwright validation (`PW-TAURI-WIN`, `PW-TAURI-WIN-PACKAGED`):** Use the instrumented build to enumerate/invoke every production handler. Then use separate exact-package launches and `HARNESS-13` to invoke every shipped Edit/View/Window/Help command through the real native menu, asserting copy/paste, Preferences, reload, each zoom command, fullscreen, updater, About/version, and production-appropriate DevTools absence/behavior.

- [ ] **TAURI-28 — Complete secure external-link handling.** Canonicalize HTTP(S), reject unsafe schemes/credentials/control characters/untrusted frames, and open exactly once in the system browser.
  - **Playwright validation (`PW-TAURI-WIN`, `PW-TAURI-WIN-PACKAGED`):** In the instrumented build, Ctrl-click a valid link and assert one recorded production-handler call; reject `file:`, `javascript:`, credentialed/malformed URLs and hostile iframe calls with zero opens. In a packaged VM, register a harmless recorder as the default HTTP handler, click a valid link, and assert Windows Shell delivers the canonical URL exactly once.

- [ ] **TAURI-29 — Wire real WebView2 crash and hang recovery.** Connect native renderer-failure/unresponsive events to the backoff/circuit-breaker logic and restore authenticated tabs.
  - **Playwright validation (`PW-TAURI-WIN-PACKAGED`):** From host automation, terminate the exact packaged app's real WebView2 renderer, reconnect CDP to the replacement target, and assert restored UI/tabs/log event. Hang a sacrificial renderer at OS level to verify native watchdog recovery, then repeat failures to assert 250 ms/1 s/3 s backoff, maximum attempts, explanation, and manual retry—without an E2E handler injection.

- [ ] **TAURI-30 — Recover server reachability.** Show disconnected state, reconnect app-bound at the same URL/token, and route permanently unavailable remotes back to chooser rather than endless blank reload.
  - **Playwright validation (`PW-TAURI-WIN`):** Stop/restart the exact child after main loads and assert layout-preserving reconnect; leave a remote offline and assert bounded retries followed by chooser/error actions.

## P2 — Packaging, installer, updater, and upgrade path

- [ ] **PACKAGE-01 — Bundle every runtime resource.** Include the Rust server, main client, setup wizard, launch chooser, their capability files/icons, built-in extension manifests/assets/icons, client/server extension content, and required provider resources. Installed operation must not depend on a source tree, Node/npm, Cargo, or development variables.
  - **Playwright validation (`PW-TAURI-WIN-PACKAGED`):** Install in a clean VM with no checkout/toolchains, put the deterministic external Amplifier CLI fixture on `PATH`, run wizard/chooser, create a shell, launch Amplifier through its bundled Freshell manifest/icon, and load one bundled client/server extension. Assert every Freshell-owned executable/UI/asset path is installed resources while the external CLI resolves only from the fixture path.

- [ ] **PACKAGE-02 — Produce one supported Windows NSIS installer with running-process safety.** Support interactive/unattended install, spaces/Unicode, Start Menu, and uninstall registration. Detect running Electron/Tauri/Freshell-owned processes without matching unrelated names; interactive mode offers clean close/retry/cancel, silent mode exits nonzero without partial mutation. Uninstall retains the profile by default; removal requires explicit opt-in.
  - **Playwright validation (`PW-TAURI-WIN-PACKAGED`):** Install/upgrade/uninstall while exact Electron or Tauri processes are open and while a similarly named sentinel runs; assert prompts and clean close/retry, silent nonzero/no-mutation behavior, and sentinel survival. Then verify both install modes/registrations and both profile-retention choices remove only the documented Freshell-owned files.

- [ ] **PACKAGE-03 — Ship correct application identity and icons.** Keep product name, identifier, executable metadata, window/taskbar/tray icons, installer entry, and filenames consistent.
  - **Playwright validation (`PW-TAURI-WIN` packaged):** Inspect executable/installed metadata and native icon handles through the Windows helper, assert expected name/identifier/icon resources, and launch to confirm window/tray/taskbar use the packaged icon. This permanently gates the local icon fix.

- [ ] **PACKAGE-04 — Sign executable, server, installer, and update artifacts.** Use the expected publisher, trust chain, and timestamp.
  - **Playwright validation (`PW-TAURI-WIN` packaged):** Invoke Windows signature verification from the Playwright runner for every executable artifact, assert the expected valid signer/timestamp, then launch/attach normally.

- [ ] **UPDATE-01 — Register and prove the real production updater key and endpoint.** The shipped artifact must contain the production public key/unchanged HTTPS URL; tests never receive the production private key or silently override that configuration.
  - **Playwright validation (`PW-TAURI-WIN-PACKAGED`):** Inspect the exact artifact for the expected public-key fingerprint and endpoint, redirect that unchanged hostname inside a disposable VM through trusted test DNS/TLS to a release-pipeline pre-signed fixture, and assert a valid availability response. Serve a wrong-key manifest and assert rejection without download/install; no production signing occurs in the test job.

- [ ] **UPDATE-02 — Implement the legacy updater states and actions.** Cover checking, current, available, downloaded, error, install/restart, and no-downgrade/platform matching. Progress/cancel/retry UI is separate product scope, not required for parity.
  - **Playwright validation (`PW-TAURI-WIN`, `PW-TAURI-WIN-PACKAGED`):** Use a native E2E package built with a test public key to drive equal/older/wrong-platform/valid-newer and failed-download feeds through every state, install/restart, and reconnect CDP. Separately run the production-package availability/install smoke with the pre-signed release-pipeline fixture from `UPDATE-01/05`, proving the real configuration without exposing its private key.

- [ ] **UPDATE-03 — Preserve state and process ownership across update restart.** Migrate settings/tabs, close the old tree, start exactly one new tree, and recover or explain live terminal loss.
  - **Playwright validation (`PW-TAURI-WIN` packaged):** Seed preferences and 16 layouts with an app-bound terminal, apply update, and assert one replacement process tree, preserved state, documented terminal recovery, and no old/orphan listener.

- [ ] **UPDATE-04 — Verify installer handoff into `TAURI-16`.** This item owns the NSIS property/argument plumbing only; `TAURI-16` remains the single implementation of atomic one-shot provisioning.
  - **Playwright validation (`PW-TAURI-WIN-PACKAGED`):** Install with fixture remote properties, prove NSIS hands the exact values to the `TAURI-16` path, launch/authenticate, assert the one-shot receipt/removal, relaunch without installer input, and verify saved remote config still works.

- [ ] **UPDATE-05 — Generate, sign, publish, and validate release-update metadata.** Release CI must produce platform artifacts plus `latest.json` using the same version, real downloadable URLs, hashes, and Tauri signature expected by the installed updater.
  - **Playwright validation (`PW-TAURI-WIN-PACKAGED`, release-candidate feed):** Download the actually published manifest/artifact from a staging release, assert version/platform/URL/hash/signature and Authenticode identity, then update an installed prior version through the UI and verify the launched binary hash/version equals the published artifact.

- [ ] **MIGRATE-01 — Define the explicit Electron→Tauri state policy.** Classify tabs/layout, browser preferences, auth, recency, prompt/input history, device identity, cursors, activity/attention, and unknown/transient keys as import, merge, reset, or reject.
  - **Playwright validation (`PW-TAURI-WIN` + Playwright Electron):** Seed every known and unknown key through a real legacy profile, migrate, and assert each follows the documented policy; unknown data must not execute or silently delete valid state.

- [ ] **MIGRATE-02 — Build a supported export/import bridge independent of web origin/port.** Do not rely on Chromium and WebView2 sharing storage directories.
  - **Playwright validation (`PW-TAURI-WIN` + Electron):** Create state through the legacy UI on one server port, close Electron, launch Tauri with a separate empty WebView2 profile and different port, and assert migration still succeeds.

- [ ] **MIGRATE-03 — Migrate the complete tab/pane layout.** Preserve order, active tab, names, splits, ratios, pane kinds, cwd, URLs/files, agent settings, and durable provider identities.
  - **Playwright validation (`PW-TAURI-WIN` + Electron):** Create 16 representative legacy tabs including split layouts and every provider, migrate, then compare rendered order/layout and serialized fields; assert each provider resumes its known fixture session rather than starting fresh.

- [ ] **MIGRATE-04 — Migrate browser-local preferences.** Include theme, UI scale, terminal/editor fonts, sidebar visibility/width/sort and actual local visibility filters, sound/notifications, panes, and rich-agent preferences. Server-wide first-chat exclusions belong to `MIGRATE-06`/`SESSION-13`.
  - **Playwright validation (`PW-TAURI-WIN` + Electron):** Set distinctive nondefaults through the real legacy UI, migrate, and assert Tauri controls/computed styles/local filters; change one Tauri value and prove relaunch does not reimport over it.

- [ ] **MIGRATE-05 — Reuse the legacy auth secret under the `TAURI-04` bootstrap contract.** Keep the same token for upgrade while limiting it to approved credential storage and the transient initial navigation URL, which is immediately scrubbed and excluded/redacted from retained artifacts.
  - **Playwright validation (`PW-TAURI-WIN`):** Seed a distinctive legacy token, migrate, assert Tauri and Rust authenticate with it, assert the post-bootstrap URL is clean, and scan retained traces/logs/screenshots/history/persisted files to ensure it appears only in the documented credential locations.

- [ ] **MIGRATE-06 — Preserve complete server configuration losslessly through the `CFG-01` writer.** Retain all overrides, first-chat controls, colors, recents, migrations, legacy seed, secrets, and unknown future fields through migration and the first Tauri save.
  - **Playwright validation (`PW-TAURI-WIN`):** Hash/count every seeded collection, migrate, change one ordinary setting, restart, and assert schema validity plus exact unrelated values.

- [ ] **MIGRATE-07 — Make migration atomic, backed up, resumable, idempotent, and reversible.** Support failure at every phase and an explicit rollback/result receipt.
  - **Playwright validation (`PW-TAURI-WIN` fault fixture):** Fail before backup, after backup, mid-import, and before marker; relaunch after each and assert untouched legacy source plus rollback/resume. A successful second launch must make no changes; invoke rollback and assert the prior Tauri state returns.

- [ ] **MIGRATE-08 — Merge safely with an already-used Tauri profile.** The safe default keeps existing Tauri preferences and adds only unique missing legacy tabs. Replace is a separate explicit choice shown only after creating a restorable Tauri backup; no valid conflicting state may be silently dropped.
  - **Playwright validation (`PW-TAURI-WIN`):** Seed distinct and duplicate Electron/Tauri layouts/preferences, accept the default and assert existing preferences plus unique legacy tabs with stable order/no duplicates; repeat with explicit Replace, assert the backup receipt first, then restore it and recover the exact original Tauri state.

- [ ] **MIGRATE-09 — Handle malformed, obsolete, future, and oversized legacy storage.** Recover safe portions and remain launchable with clear backup/error information.
  - **Playwright validation (`PW-TAURI-WIN`):** Parameterize corrupt JSON, old supported schema, unsupported future schema, and large valid layouts; assert correct recovery/rejection, visible nontechnical explanation, backup location, and usable main/rollback path.

- [ ] **MIGRATE-10 — Coexist safely with a running legacy installation.** Never kill/mutate the legacy process or steal its port; offer connect or another port.
  - **Playwright validation (`PW-TAURI-WIN` + Electron):** Keep legacy running on the configured port, launch Tauri, exercise connect/change choices, close Tauri, and assert the legacy window/server/session marker remains usable and unchanged.

- [ ] **MIGRATE-11 — Discover the installed Electron profile automatically.** Locate the real legacy user-data roots/origins without a manually supplied source path and handle multiple profiles/origins, a live database lock, portable/moved profiles, and no legacy profile.
  - **Playwright validation (`PW-TAURI-WIN` + Playwright Electron):** Install/run legacy normally, create multiple origin/profile fixtures, and launch Tauri without any migration-path override. Assert deterministic candidate choice or accessible chooser, a non-destructive “close legacy and retry” lock state, portable-profile selection, and a clean no-profile first run.

- [ ] **MIGRATE-12 — Show a useful migration result receipt.** After import, show counts for tabs/panes/preferences/server settings, backup and rollback location, skipped/unsupported items, and whether any partial recovery occurred; persist the receipt for later review.
  - **Playwright validation (`PW-TAURI-WIN`):** Run complete and partially recoverable fixtures, assert the keyboard-accessible result screen and persisted receipt match exact source/result counts and omissions, open the backup/rollback action, then relaunch and review the same receipt without rerunning migration.

- [ ] **MIGRATE-13 — Validate a real Electron-installer to Tauri-installer upgrade and rollback.** Choose replacement rather than side-by-side, migrate state, replace owned registrations without duplicates, and retain a hashed copy of legacy user data plus the exact signed Electron installer/version needed to restore binaries and registrations. Apply `PACKAGE-02` running-process rules during upgrade.
  - **Playwright validation (`PW-TAURI-WIN-PACKAGED` + packaged Electron, disposable VM):** Install/relaunch the released Electron build, create state, leave it open once to test the guard, then upgrade and assert one shortcut/uninstall/startup owner plus 16 tabs. Invoke rollback, reinstall the retained verified Electron version, restore registrations/profile into a separate working copy, and prove it launches with the pre-upgrade state while immutable source hashes remain unchanged.

## P2 — Current `main` catch-up not otherwise covered above

Most current-main provider, title, pagination, timestamp, extension, lifecycle, and release work is already included in the relevant sections. The remaining visible settings work is listed here.

- [ ] **SYNC-00 — Reconcile the branch with current `main` before implementation and again before release.** Resolve conflicts intentionally, preserve Rust/Tauri work, and regenerate the main-drift inventory so newly shipped legacy behavior cannot fall through the checklist.
  - **Playwright validation (`PW-RUST`):** After each reconciliation, run the Node/Rust matrix and a generated inventory test that asserts every client-used route/message/provider on current `main` has a Rust capability or an unchecked checklist ID; the final run must have no unowned gaps.

- [ ] **SYNC-01 — Raise UI scale to 400% with direct percentage input.** Preserve keyboard accessibility, bounds, and persistence.
  - **Playwright validation (`PW-RUST`, `PW-TAURI-WIN`):** Enter boundary, invalid, and 400% values, assert computed scaling and usable/focusable controls at 400%, then reload/restart and verify persistence/clamping.

- [ ] **SYNC-02 — Raise terminal font size to 64 px with direct input.** Update live xterm metrics safely and persist.
  - **Playwright validation (`PW-RUST`, `PW-TAURI-WIN`):** Enter boundary/invalid/64 values, assert xterm canvas/cell measurements change and terminal I/O remains usable, then reload and assert persistence.

- [ ] **SYNC-03 — Make Editor font follow terminal font.** Update existing/new Editor panes live and after restart.
  - **Playwright validation (`PW-RUST`, `PW-TAURI-WIN`):** Open terminal and editor side by side, change font size, compare computed text sizes immediately and after reload.

- [ ] **SYNC-04 — Remove deprecated `freshAgent.fontScale`.** Migrate supported behavior without retaining a dead control or allowing the stale field to override current settings.
  - **Playwright validation (`PW-RUST`):** Seed the deprecated property, launch and assert no exposed control/effect, perform a settings save, and verify it is removed while supported rich-agent sizing remains correct.

- [ ] **SYNC-05 — Gate current-main expected-restart behavior across owners.** This regression gate depends on `TERM-22`, `SAFE-11`, and `TAURI-30`; expected restart reconnects quietly while unexpected crash retains diagnostics.
  - **Playwright validation (`PW-RUST`, `PW-TAURI-WIN`):** After the dependent implementations pass, capture browser console/toasts/logs across deliberate general/Codex/app-bound restarts and equivalent crashes; assert no user-facing error noise for expected cases with successful reconnect and actionable diagnostics for unexpected cases.
  - PARTIAL (2026-07-18): `test/e2e-browser/specs/restore-sync05.spec.ts` :: "a live terminal pane reconnects quietly after a deliberate server restart, with no user-facing error noise" — asserts zero `role="alert"` elements, no auth-required modal, no plain-text error language, and a genuinely functional post-restart terminal, across a real `server.restart()`; green both projects. MISSING: by the spec's own scope note this covers only the GENERAL (plain-terminal) deliberate-restart case — the Codex/app-bound restart leg, the equivalent-crash/diagnostics-retained leg, and the `PW-TAURI-WIN` half of the validation are explicitly out of scope and left to dependent tickets.

## Final release gates

- [ ] **GATE-01 — Run the unchanged legacy browser suite against both Node and Rust.** No Rust-only skips for a user-visible feature are allowed.
  - **Playwright validation:** The Node/Rust project matrix runs every externally and lifecycle targetable spec; normalized behavior and committed visual baselines pass for both, with a machine-readable skipped-test report required to be empty or explicitly approved.

- [ ] **GATE-02 — Run the full native Windows Tauri WebView2 suite against the packaged installer.** WSLg or a Chromium mirror does not substitute for this gate.
  - **Playwright validation:** Install in a disposable clean Windows VM, attach to the real WebView2, run startup/wizard/chooser/tray/recovery/network/provider/migration/update scenarios, and uninstall with retained traces and process/config receipts.

- [ ] **GATE-03 — Prove upgrade safety on a copy of a representative legacy profile.** Include the 16-tab fixture and a large loss-detection config.
  - **Playwright validation:** Keep one immutable hashed source profile, clone a separate migration working copy, install/launch/migrate/use/save/restart/update Tauri, and compare every accepted item. Roll back into a second restored working copy, launch that copy, close it, and compare its expected runtime mutations separately; the never-launched immutable source must remain byte-identical.

- [ ] **GATE-04 — Prove multi-client isolation and recovery.** Cover two browser profiles plus Tauri sharing one Rust server.
  - **Playwright validation:** Run distinct terminals/agents/layouts concurrently, reconnect/restart/crash one client and server, and assert correct shared state, private session event isolation, targeted screenshots, bounded catch-up, and no duplicated process owners.

- [ ] **GATE-05 — Prove resource and process hygiene under stress.** Set explicit latency, RSS, handle, queue, process, and port ceilings before accepting the port.
  - **Playwright validation:** Run the mixed-load soak plus repeated desktop close/reopen, provider crash/recovery, extension proxy, and update cycles; assert ceilings and zero owned leftovers while unrelated sentinels survive.

- [ ] **GATE-06 — Prove security boundaries.** Cover auth, origins, rates, file roots, proxy destinations, extension paths/processes, event subscriptions, privileged networking, and updater signatures.
  - **Playwright validation:** Run the complete negative matrix and assert no unauthorized data, file, process, listener, firewall, service, or update mutation occurs; follow each negative case with a valid operation to prove safe recovery.

- [ ] **GATE-07 — Prove accessibility and keyboard use.** All new controls must be understandable and operable without a mouse.
  - **Playwright validation:** Complete first-run setup, launch choice, terminal/provider creation, session search/mutations, pane management, settings, approvals/questions, migration, and update using only role/label locators and keyboard input.

- [ ] **GATE-08 — Produce one parity receipt.** Record exact source commits, binaries/hashes, platforms, test commands/counts, pass/fail/skips, performance ceilings, migration hashes, screenshots/traces, process cleanup, and any approved deviations.
  - **Playwright validation:** A final Playwright reporter/validator reads the receipt and artifacts, rejects missing/stale/mismatched evidence, and links every checklist ID to at least one passing test result.

## Completion rule

The port is ready to replace legacy only when every checkbox above is complete, the final gates pass against the packaged native Windows application, and the upgrade test proves that the legacy profile remains recoverable. Passing a narrow protocol oracle, rendering the retained React UI, or successfully building a debug `.exe` is not sufficient.
