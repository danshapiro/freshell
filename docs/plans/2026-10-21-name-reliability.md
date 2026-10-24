# Name Reliability Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below. Every task is red → green →
> refactor; a task is not done until its red receipt, green receipt and
> refactor note are recorded. A step labelled **pinning test** is expected to
> pass before the change; it guards behavior the change must keep and is not
> a red step.

## User Request

### Requested result
Complete the pane/tab naming-reliability work recovered from Claude session b0e858cc-c789-4cc8-aba4-46c81f21d8b8. Rebase fix/name-reliability onto current main, preserve the intended naming fixes alongside main's new behavior, finish remaining necessary repairs and validation, then land via the already-authorized PR path.

### Explicit constraints
- At most 10 additional repair/review rounds are authorized. Stop immediately at the first passing result; no further fixes or review rounds after it passes.
- Keep all work in /home/dan/code/freshell/.worktrees/name-reliability on fix/name-reliability. Preserve unrelated work. Rebase is explicitly authorized.
- One durable saved name per coding-agent session; manual names protected; a conversation switch adopts its new session's name. No repair command or dedicated naming proxy.
- Preserve main's current Freshclaude identity, lifecycle and attention behavior.
- Use meaningful red/green/refactor tests and unit/integration/browser coverage. Do not weaken or skip tests. Fix observed test races. Use coordinated broad gates and the destructive-test sandbox.
- Known main failures require reproduction evidence before any baseline qualification. Unknown/new failures remain failures.
- One PR targeting main, already approved for creation and merge after checks; do not ask again. No production deployment or port3001 restart without the user's exact APPROVED, not given.

### Accepted tradeoffs and residuals
Existing accepted limitations in the committed naming plan remain: one-file name storage, recognizable-junk-only healing, unindexed/exhausted histories, incomplete closed-registry cleanup, inherited OneCLI only without a configured Gemini key, and deployment-time quota confirmation. The separate pre-existing managed-shell restart and initial Freshclaude view-flavor persistence issues stay outside this change.

**Goal:** A Claude, Codex or OpenCode session gets a sensible name (first
message, then Freshell's AI name) and keeps it across reloads, new windows,
reconnects and server restarts, and a conversation switch shows the new
conversation's name; shells, browsers and editors keep their user names in
new windows and across managed-runtime refreshes; a saved name that is
recognizable junk ("Tab 23", "OpenCode agent", tool wrapper text, a provider
placeholder) is replaced by the next real automatic name the session offers,
so existing damage heals as sessions are seen, while names a person chose are
never touched.

**Architecture:** (1) The browser stops treating its live layout as "legacy"
name evidence: capture runs once per device, only from genuine pre-migration
keys, and once the one-time consolidation is complete the server acknowledges
browser imports without writing anything. (2) One shared default-label
classifier (TypeScript + Rust, one shared fixture) keeps "Tab N", folder
names, provider labels, OpenCode placeholders and tool wrapper text out of
every name-evidence path. (3) The naming store gets four ranking fixes:
provider-native titles that actually change may replace an older automatic
provider-level name, automation renames report applied/not-applied, the
first-message fallback is offered on every newly observed first message, and
the self-heal rule: an unprotected record whose current name the classifier
recognizes as default/derived ranks below `directory` for every automatic
offer, so the next real name replaces it. (4) A configured Gemini key always
wins and is used directly; only with no key does AI naming fall back to the
inherited OneCLI proxy; credential and quota failures pause naming without
using up attempts or losing the naming input. (5) On the client, a
session-owned tab's stored title becomes a display mirror of the saved name,
written only when a saved record is known; the managed-runtime merge never
writes names; the new-window rebuild carries pane titles and user flags.
(6) On the server, every terminal row binds its name through one helper that
both doors (WebSocket and REST) can call, and a conversation switch moves the
row's binding to the new session; the name store serves reads without the
lock; every accepted change emits one structured event.

**Tech Stack:** TypeScript client (React 18, Redux Toolkit, Vitest jsdom),
Rust server crates (`freshell-server`, `freshell-ws`, `freshell-terminal`,
`freshell-sessions`, `freshell-protocol`, `freshell-freshagent`,
`freshell-supervisor`, `freshell-codex`), Playwright e2e with the owned
`RustServer` fixture.

## Global Constraints

- **Worktree:** `/home/dan/code/freshell/.worktrees/name-reliability`, branch
  `fix/name-reliability` from `origin/main` (1c7e4dff7 at revision time; the
  plan's line numbers were read at 302cee989 and re-checked: #851 between them
  touched only `crates/freshell-codex`, its tests and one codex e2e spec, so
  every naming line number below holds; `git fetch origin` and re-check
  before creating the worktree). Before creating the worktree run the
  green-base check through `GCLOUD_ROBOT_REQUIRE=1 scripts/base-gate.sh test`.
- **Known baseline failures (Dan waived them on 2026-10-22; the branch must
  not add failures):** on
  `origin/main` the coordinated suite has exactly 7 failing tests in 3 files,
  all Docker managed-runtime host timeouts unrelated to naming:
  `test/integration/server/managed-provider-parity.test.ts` (7 cases),
  `test/integration/server/fresh-agent-parity.test.ts` and
  `test/integration/server/provider-parity-contract.test.ts` (failing as
  wrappers of the same timeouts; receipt
  `/tmp/claude-1000/-home-dan-code-freshell/b0e858cc-c789-4cc8-aba4-46c81f21d8b8/scratchpad/base-gate-rerun.log`
  lines 777–1053). Every gate in this plan treats that exact set as the
  baseline: the run passes when the failing set is identical or smaller, and
  fails on any new failure. Record the failing-test list in each gate receipt.
- **Focused client tests:**
  `pnpm run test:vitest run <paths...> --config config/vitest/vitest.config.ts`.
  Never raw `pnpm exec vitest`/`npx vitest`.
- **Focused Rust tests:** for `freshell-server`, use the coordinator's
  delegated narrowed lane `pnpm run test:server <one filter>` (it runs
  `cargo test -p freshell-server --locked <filter>`; see
  `scripts/testing/coordinator-command-matrix.ts:177-180`). The coordinator
  has no narrowed lane for other crates, so those use
  `~/.local/bin/mise exec rust@1.96 -- cargo test -p <crate> --locked <one filter>`.
  Cargo accepts ONE name filter per run: two filters mean two commands.
  Broad Rust lane: `pnpm run test:server` (coordinated).
- **E2e:** `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e --project=chromium <spec paths...>`
  (no `--` separator). Specs that need the host Docker supervisor are added to
  `LOCAL_ONLY_SPECS` in `test/e2e-browser/playwright.config.ts`; every
  other new spec must be cloud-legal and must NOT be added to
  `CLOUD_SKIP_SPECS`. A spec that matches zero tests is not coverage.
- **Local-only (Docker supervisor) runs (V3).** Every local-only command has
  this exact shape, one case at a time:
  `env -u FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE -u FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE -u FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE pnpm run test:e2e:local --project=chromium <spec> --grep '<exact case name>'`
  (three separate `-u` flags: a brace expansion would hand `env` the second
  and third names as the command). The shell exports those OneCLI grant
  files, and with them a managed OpenCode case can spend real model turns on
  Dan's credential. Run `--list` with the same arguments first and confirm
  exactly the intended case is selected. Before the first run, make sure
  Playwright 1.58.2's `chromium-headless-shell` revision 1208 is installed
  (`~/.cache/ms-playwright/chromium_headless_shell-1208`; if it is missing,
  install it into a scratch `PLAYWRIGHT_BROWSERS_PATH` with
  `pnpm exec playwright install chromium-headless-shell` rather than changing
  the shared cache). Managed-runtime rigs (these specs and the
  `test/integration/server` managed parity files) run alone, never in
  parallel with another managed rig: run alone they passed, run together
  they timed out (V3; the cause is inferred, Residual 22). Never run `runtime-terminal-continuity-rust.spec.ts` for
  this plan: its P2-G01 is red on `main` (Residuals, out-of-scope finding)
  and its P2-G04 makes paid model calls.
- **Cloud env (non-login shells):** export `FRESHELL_VITEST_BACKEND=cloud`,
  `FRESHELL_E2E_BACKEND=cloud`, `GCLOUD_ROBOT_REQUIRE=1` when unset.
- **Full gate:** `FRESHELL_TEST_SUMMARY="name-reliability task N gate" GCLOUD_ROBOT_REQUIRE=1 pnpm run check`
  (typecheck then coordinated suite). Check `pnpm run test:status` first;
  never kill a foreign holder.
- **Lint/format:** `pnpm run lint` (jsx-a11y), `pnpm run typecheck`,
  `~/.local/bin/mise exec rust@1.96 -- cargo fmt --all --check`,
  `~/.local/bin/mise exec rust@1.96 -- cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings`.
  The native Windows `freshell-server.exe` build must keep compiling: any
  platform-specific code is behind `#[cfg(unix)]`/`#[cfg(windows)]` and uses
  only stable std APIs (Task 11).
- **Destructive tests:** none of the planned tests kill processes outside an
  owned fixture or corrupt host config. Server restarts happen only on owned
  `RustServer` instances on ephemeral ports (the existing restart-spec
  pattern). If an implementer finds a test that must kill an unowned process
  or storm restarts, it moves into `scripts/sandbox-test.sh "<command>"`.
- **1000-line rule:** these files are over the cap and get wiring-only edits;
  new logic goes in the new modules named in each task:
  `crates/freshell-server/src/session_names.rs` (4104),
  `crates/freshell-server/src/main.rs` (7812),
  `crates/freshell-server/src/ai_title.rs` (1191),
  `crates/freshell-server/src/auto_title_sweep.rs` (2439),
  `crates/freshell-server/src/recovery_inventory.rs` (1772),
  `crates/freshell-server/src/managed_runtime.rs` (1814),
  `crates/freshell-server/src/fresh_agent_proxy.rs` (1431),
  `crates/freshell-server/src/terminals.rs` (1957),
  `crates/freshell-server/src/session_name_migration.rs` (1006),
  `crates/freshell-ws/src/terminal.rs` (15408),
  `crates/freshell-ws/src/identity.rs` (1619),
  `crates/freshell-terminal/src/registry.rs` (15751),
  `crates/freshell-freshagent/src/naming.rs` (1226),
  `crates/freshell-freshagent/src/terminal_tabs.rs`,
  `crates/freshell-freshagent/src/lib.rs`,
  `crates/freshell-codex/src/remote_proxy.rs`,
  `src/App.tsx` (2571), `src/store/tabsSlice.ts` (1944),
  `src/store/panesSlice.ts` (3050), `src/components/TerminalView.tsx` (7806).
- **Logging:** every new decision path logs structured JSONL with severity
  through `tracing` (server) or `createLogger` (client; errors forward to
  `/api/logs/client`). Never log credentials, tokens, proxy URLs or OneCLI
  manage URLs. Prompt/turn content is not logged, with one deliberate
  exception: `session_names.name_changed` logs the saved display names,
  at most 200 characters each (a `first_message` name is cut to 50), through
  the JSONL writer's secret scrubber. Other failure diagnostics use error
  codes and statuses. The JSONL writer's
  scrubber recognizes only the old `AIza…` Gemini key form, and Dan's key is
  the newer `AQ.` form, so Task 6 extends it (G48).
- **Rename contract:** user-intent renames always win; nothing automatic ever
  replaces `manual`, `legacy_protected` or `freshell_ai`. Shell/browser/editor
  names stay in the legacy four-scope model.
- **Commits:** one focused commit per task (conventional message, ends with
  the attribution line from the session reminder). Push the branch at major
  checkpoints. The single PR is opened only in Task 13, after the code review
  and the gate (Dan approved creating and merging it then).
- **Load-bearing validation:** round 1 validated five assumptions (V1–V5,
  section near the end) and every result is applied in the tasks below.
  Steps that rest on one cite it; the task receipt records that the
  implementation matches.

## Verified ground truth (origin/main; lines at 302cee989, unchanged at 1c7e4dff7)

Each fact below was re-read in the tree while writing or revising this plan.
Corrections to the investigation report are marked **(corrected)**.

| # | Fact | Location |
|---|---|---|
| G1 | `isLegacyNameCaptureSourceKey` accepts the live per-window key `freshell.layout.v3.<windowId>` and its `.bak` / fresh-agent-backup channels | `src/lib/session-name-migration.ts:111-136` |
| G2 | Capture runs at module import, before the store | `src/lib/session-name-migration.ts:889-893`, imported first by `src/main.tsx:13` |
| G3 | Capture also runs in machine-workspace restore and on every sibling-window layout write | `src/lib/machine-workspace.ts:147-155`; `src/store/crossTabSync.ts:443-453` (`captureLegacyLayoutEnvelope`, `src/lib/session-name-migration.ts:299-326`) |
| G4 | Submission fires on every connection-ready edge; nothing checks for a finished migration | `src/store/store.ts:162-196`; `submitPendingLegacyNameImports` `src/lib/session-name-migration.ts:771-821` |
| G5 | Tab titles of session-owned tabs become `source_tab` candidates ranked `provider_ai`; pane titles likewise; a legacy tab whose `titleSetByUser` is true and whose first leaf is a scoped pane becomes `legacy_protected` **(new finding)** | `extractEnvelopeCandidates` `src/lib/session-name-migration.ts:482-630` (tab at 568-593, panes at 596-627) |
| G6 | Acknowledgment only adds an `.ack.` marker; envelopes are never deleted | `markAcknowledged` `src/lib/session-name-migration.ts:169-178` |
| G7 | A failing capture defers the whole layout flush | `src/store/persistMiddleware.ts:658-671` via `ensureLegacyNameCapturesForFlush` `src/lib/session-name-migration.ts:346-352` |
| G8 | The import route never checks `migration.completed`; every import writes a create-once backup file keyed by import id BEFORE acknowledging, and every newly seen candidate id is pushed into `acknowledged_candidate_ids`, which forces a document write | route `crates/freshell-server/src/session_name_routes.rs:317-390`; decision `crates/freshell-server/src/session_names.rs:4003-4104` (backup `:4029`, ack push `:4053-4057`, write forced `:4094-4103`); backup writer `:3734-3770` |
| G9 | Rank order `directory 0 < first_message 1 < provider_ai 2 < freshell_ai 3 < legacy_protected 4 < manual 5`; untrusted manual/protected claims without evidence degrade to `provider_ai` | `source_rank` `session_names.rs:2034-2043`; `classify_legacy_candidate` `:3623-3673` |
| G10 | Equal-rank ties among migration-owned records end on evidence key (contains the window id) then candidate id | `compare_classified_candidates` `session_names.rs:3682-3712`; applied at `:3836-3851` |
| G11 | A missing record is installed by any import; pending targets (including derived `legacy-pending` handles) are installed too, which mints orphan records | `apply_legacy_candidate` `session_names.rs:3815-3881`; handle derivation `src/lib/session-name-migration.ts:461-475` |
| G12 | Bind collision: equal automatic ranks favor the durable record, so an import that landed on the session key first keeps its label | `bind_pending_decision` `session_names.rs:2489-2625` (collision at 2537-2553) |
| G13 | Automatic offers only strictly raise rank; automation renames map to `provider_ai` and return the unchanged record as success | `offer_mut` `session_names.rs:2147-2204`; `rename_decision` `:2427-2464` |
| G14 | Native observations offer at `provider_ai` with no placeholder filter; the only placeholder predicate is used by the directory index; every call site discards the result (`let _ =`) and awaits it INLINE in an event relay loop | `observe_native_decision` `session_names.rs:2802-2930`; `is_opencode_placeholder_title` `crates/freshell-sessions/src/parse/opencode.rs:35`; OpenCode event `crates/freshell-opencode/src/events.rs:198-210`; inline awaits: freshopencode SSE bridge `crates/freshell-freshagent/src/opencode_ws.rs:7787-7805`, codex proxy route `crates/freshell-ws/src/codex_proxy_route.rs:112-131`; other lanes `crates/freshell-server/src/main.rs:1955-1985`, `crates/freshell-freshagent/src/codex.rs:7622` |
| G15 | First-message fallback is offered only for `AcceptedUserMessage`/`IndexUserMessage`; the sweep sends `Opened` whenever a live terminal is bound | `plan_activity` `session_names.rs:2651-2727` (gate at 2668-2681); sweep `crates/freshell-server/src/auto_title_sweep.rs:470-523` |
| G16 | The Gemini route is `OneCliProxy` whenever the effective proxy URL carries a OneCLI marker; `enabled()` is then true without any key; on that route the first request carries NO key even when one is configured (`:332-334`), so with Dan's Settings key and the inherited proxy, naming still fails on `access_restricted` (confirmed live, G49); a 403 drops the body; only `credential_not_found`/`app_not_connected` permit a direct-key retry (through the same proxy-honoring client); 407 never does. Both naming and summary clients are `reqwest::Client::new()`, which honors the ambient proxy | `crates/freshell-server/src/ai_title.rs:256-288`, `:325-391` (error at 385), `:437-450`; clients `main.rs:974`, `:985` |
| G17 | Each failure consumes one of `MAX_GENERATION_STARTS = 3`. The CLAIM (not the fold) exhausts the series at the cap and clears the excerpt; the fold only sees `(series_id, fingerprint, outcome)`; the failure reason is never persisted; boot recovery of an interrupted start already exhausts and clears at the cap | `session_names.rs:100`; claim `:3030-3061` (exhaust + `excerpt = None` at 3038-3043); fold `:3063-3152`; recovery `recover_interrupted_generation_decision` `:3154-3185`; generator `crates/freshell-server/src/session_name_generation.rs:233-351` |
| G18 | **Open question 1 answered:** the server's Gemini key is env `GOOGLE_GENERATIVE_AI_API_KEY` (wins at boot) else `settings.ai.geminiApiKey` in `<FRESHELL_HOME>/config.json`; every successful Settings save force-applies the Settings key into the same key cell. The live config copy (taken before 2026-10-22) had `settings.ai = {}`; **Dan has since entered a key in Settings** (whether the live process also has an env key is part of V1). The probe answered `{"error":"access_restricted",…}` from the OneCLI gateway. The proxy (and so the OneCLI agent identity) is whatever `HTTPS_PROXY` the launching shell exported; the server's `.env` cannot override it because environment variables win over `.env` | `crates/freshell-server/src/main.rs:953-964`; `crates/freshell-server/src/settings_store.rs:2139-2143`; `scratchpad/live-evidence/config.json`; `scratchpad/live-evidence/gemini-probe.json`; `.env` precedence per `AGENTS.md` |
| G19 | The managed merge writes `title: view.title` for existing tabs unless `titleSetByUser`, takes tab-level fields from whichever pane matched, and bumps `updatedAt` | `buildManagedRuntimeMergePlan` `src/lib/recovery/managed-runtime-recovery.ts:291-372` (title 323, reconstructed title 359); `updateTab` `src/store/tabsSlice.ts:404-410` |
| G20 | View-intent titles are fixed provider labels | `crates/freshell-server/src/managed_runtime.rs:776`; `crates/freshell-server/src/fresh_agent_proxy.rs:723`; fallback "Recovered X agent" `crates/freshell-supervisor/src/view_intents.rs:103-106`, `:683-689` |
| G21 | **Open question 6 answered (code):** "Shell agent" IS visible on a single-pane shell tab: `getTabDisplayTitle` shows a stored non-default `tab.title` that differs from the derived name whenever no non-derived pane title exists | `src/lib/tab-title.ts:19-38`. Task 8's first test pins this. |
| G22 | Nothing writes the saved name back into a session-owned tab's `title`; the display falls back to it when no record is cached | `src/App.tsx:1472-1477`; `selectTabDisplayName` `src/store/selectors/sessionNameSelectors.ts:217-230`; the comment in `stripSessionOwnedTabFreezeFlags` `src/lib/session-name-migration.ts:870-887` is false today |
| G23 | Legacy tab-title writers: OSC title `src/components/TerminalView.tsx:3189-3192` (**corrected: no session-owned gate here**, unlike `:6160-6176`), exit suffix `:6136-6143`, `openSessionTab` existing-tab retitles `src/store/tabsSlice.ts:1821`, `:1871`, create defaults `:358`, `:1836`, `:1912`, `:1930`, `src/store/codingAgentNaming.ts:36-42`, managed merge (G19), machine restore `src/lib/machine-workspace.ts:197-205`, UI command `tab.create` (`src/lib/ui-commands.ts:181-196`, sets `titleSetByUser:true` for any caller name, including on an agent tab). UI command `tab.rename` (`:222-226`) is already harmless for session-owned tabs: `consumeScopedRenameReceipt` (`:38-62`) returns before `applyTabRename` whenever the tab has a naming source |
| G24 | The new-window rebuild drops pane titles and user flags: plan hard-codes `paneTitles: {}`; inventory forwards only `tabKey/tabName/nameSource/panes`; the registry pane snapshot carries `title` but **no pane user flag (corrected)** | `src/lib/recovery/build-recovery-plan.ts:430-437`; `crates/freshell-server/src/recovery_inventory.rs:1010-1033`; `src/lib/tab-registry-snapshot.ts:89-113`; `shared/tab-registry-types.ts:54-59`; `restoreMachineWorkspace` `src/lib/machine-workspace.ts:197-213` |
| G25 | `register_managed` titles every managed row "Shell" with no naming; adoption paths never bind naming. **Production** callers **(corrected)**: WS managed create `crates/freshell-ws/src/terminal.rs:6876`, REST managed create `crates/freshell-freshagent/src/terminal_tabs.rs:2906`, compat adopt `terminal.rs:3459`, reconcile adopt `terminal.rs:8481`. The calls at `terminal.rs:3837, 3943, 3994, 4076` are inside `mod managed_runtime_id_tests` (`:3590-4090`) and `:13408+` inside the test module starting at `:10894` | `crates/freshell-terminal/src/registry.rs:4719-4776` (title 4752); `adopt_managed_for_reconcile` `:4646-4676` |
| G26 | `admit_create_naming` turns a read error into "no record" (`.ok()` at `:4798`), so "read failed" and "no record" arrive as the same `None`; a lock error on a resume create that carries a persisted `namingHandle` falls into the fresh-pending path (`:4799-4828`); a failed `ensure_pending` returns `None` (`.ok()?` at `:4855`), leaving the row with NO naming binding. REST create does the same | `crates/freshell-ws/src/terminal.rs:4751-4870`; REST CLI naming admission `crates/freshell-freshagent/src/terminal_tabs.rs:3457-3545` |
| G27 | Conversation switch retargets only the identity table (a durable `Session` ref moves to the new session; pending refs never move); respawn titles "<Mode> (auto-resumed)" without naming | `crates/freshell-ws/src/identity.rs:314-330`, `bind_pending_naming` `:613-655`; `respawn_agent_terminal` `crates/freshell-ws/src/terminal.rs:7680` (title `:8099-8107`) |
| G28 | Every name read takes the exclusive flock and re-parses the whole document; the read route runs `refresh_current` first; the 2 s tick runs `refresh_current` | `run_txn_sync` `session_names.rs:1395-1484`; `get` `:1164-1180`; `refresh_current` `:655-668`; lock `:94-96`, `:1706-1730`; route `session_name_routes.rs:233-248`; tick `main.rs:1352-1398` |
| G29 | **Corrected bloat breakdown** (current copy, 5,050 records): exhausted series already carry no excerpt; the excerpt bytes are Idle (boot-absorbed, never attempted) series, ~1.93 MB, and they are still needed by the explicit-open arming path; acknowledged candidate ids 0.38 MB; winning evidence 0.18 MB | `scratchpad/live-evidence/session-names.json`; arming dependency `bind_pending_decision` `session_names.rs:2603-2617` |
| G30 | Import-owned records (winning evidence still at its installed revision, unprotected) on the live copy: 188 `first_message`, 1 `directory`, 114 `provider_ai`. Of the `provider_ai` ones, 29 are default labels recognizable without a folder ("Tab N", "OpenCode agent"-style; 27 came from per-window layout keys), and 85 are other text — among them folder names ("machines", "shapiroserver2", "podcast") and labels that look typed by a person ("ms-people-summit", "DirectorDeck"). None has a generation excerpt, so first messages must come from the session index | same copy (count script: `/tmp/claude-1000/-home-dan-code-freshell/b0e858cc-c789-4cc8-aba4-46c81f21d8b8/scratchpad/plan/revision-1-notes.md`) |
| G31 | Log spam: 15,145 of 15,833 lines are `codex_proxy_repair_trigger` WARNs, all the generic `ProxyError { "Codex remote proxy client/upstream connection errored." }`, ~580 per minute spread across 6 terminals (~1.6/s each: a reconnect loop, not one burst). #851 (merged after the live build) added a per-proxy `EmissionGate` and teardown-pair suppression only for CLASSIFIED capacity errors; the generic errored trigger is still emitted unthrottled at `crates/freshell-codex/src/remote_proxy.rs:1118-1130` | `crates/freshell-ws/src/codex_proxy_route.rs:92-95`; `scratchpad/live-evidence/rust-server.jsonl`; `EmissionGate` `remote_proxy.rs:826-860` |
| G32 | Existing e2e helpers to reuse: `bootUnifiedNamesServer`, `startFakeGemini`, `startFakeOneCliGeminiProxy`, `modeFixture`, `sendFirstMessage`, `readRecord`; the Claude terminal fake is `test/e2e-browser/fixtures/providers/fake-claude.mjs` (wired as `CLAUDE_CMD` at `helpers/unified-agent-names.ts:236`) | `test/e2e-browser/helpers/unified-agent-names.ts`, `test/e2e-browser/helpers/unified-agent-names-modes.ts`; server log via `RustServer.capturedOutput()` `test/e2e-browser/helpers/rust-server.ts:571` |
| G33 | `selectScopedTabDisplayTitles` calls `selectPaneDisplayName`, which returns a FALLBACK label (`selectPaneFallbackTitle`) when no saved record is cached; the tabs registry already overlays these values onto session-owned tab records | `src/store/selectors/sessionNameSelectors.ts:165-177` (fallback at 176), `:317-338`; `selectLiveLocalTabRecords` `src/store/selectors/tabsRegistrySelectors.ts:163-186` |
| G34 | The client name cache is fed by `/api/session-names/read` bootstrap AND by record projections riding on other frames and responses (terminal/session-directory projections, rename responses) | `src/App.tsx:1253`, `:1465`, `:1475`, `:1488`, `:1715`; `src/store/sessionNamesSlice.ts:179-222` |
| G35 | Crate edge: `freshell-ws` depends on `freshell-freshagent` (`crates/freshell-ws/Cargo.toml:55`), never the reverse; `freshell-freshagent` depends on `freshell-terminal` and already bridges outward through traits (`identity_sink.rs` `PaneIdentitySink`) | `crates/freshell-freshagent/Cargo.toml:54`; `crates/freshell-freshagent/src/identity_sink.rs:1-5, 343` |
| G36 | No folder on the server side of imports and renames: `LegacyNameCandidate` and `RenameNameInput` carry no cwd, and the name document stores none. Folders are known only to `PendingNameInput.cwd` (at create), `IndexedNameInput.cwd`/`NameActivity.cwd` (session index), and the terminal row | `crates/freshell-protocol/src/session_names.rs:395-405`; `crates/freshell-freshagent/src/naming.rs:78-96`; `crates/freshell-server/src/session_name_generation.rs:116-122` |
| G37 | The sweep fetches an OpenCode first message only while `needs_generation_input` is true, which is false once a series carries a fingerprint or is exhausted — so an OpenCode session stuck on a folder name never gets the first-message fallback | `crates/freshell-server/src/auto_title_sweep.rs:441-465`; `session_names.rs:850-873` |
| G38 | `hydrate_indexed_decision` returns early whenever any record exists; the sweep pre-check `hydrate_indexed_pending` mirrors that; the `activity_pending` pre-check's comment relies on "a record's source rank never decreases" | `session_names.rs:3200-3212`, `:933-940`, `:951-960` |
| G39 | **RC12 (new):** 171 saved names on the live copy are tool wrapper text taken as the "first message": 153 `<recommended_plugins>`, 9 `<user_shell_command>`, 4 `<user_action>`, 5 `<local-command-caveat>…` (172 on the later V2 copy; 161 of them have an index row, 11 do not). The three Codex tags are Codex's own model-context fragments; in real Claude transcripts the caveat record is `isMeta` and is followed by `<command-name>`, `<local-command-stdout>` and sometimes `<system-reminder>` records before the real prompt (V5). The first-message extraction goes through `extract_user_authored_text`, whose system-context tag list (`USER_CONTEXT_TAGS`/`SYSTEM_CONTEXT_LEAD_TAGS`) does not list these tags | `crates/freshell-sessions/src/text.rs:110-140`, `:311-335`; fallback `session_names.rs:2103-2110` |
| G40 | Rename convenience routes nest the update differently: the freshagent pane/tab routes return `data.sessionName` (the full `SessionNameUpdate`) | `crates/freshell-freshagent/src/lib.rs:6064-6079` |
| G41 | Which naming inputs carry a folder: `NameActivity.cwd` (today unused by `activity_decision`, bound as `cwd: _cwd`) and `IndexedNameInput.cwd` do; `NativeNameObservation` does not. The activity pre-check runs the SAME `plan_activity` as the transaction; the hydrate pre-check is a bare "no record" test; the sweep's settled memo lasts one pass only, and every non-boot pass feeds `IndexUserMessage` for every indexed session with a first message | `crates/freshell-freshagent/src/naming.rs:117-124`, `:141-147`; `crates/freshell-server/src/session_name_generation.rs:116`; `session_names.rs:933-940`, `:963-976`, `:2729-2741`; `crates/freshell-server/src/auto_title_sweep.rs:432-436`, `:495-535` |
| G42 | The index keeps a persistent parse cache (`rust-session-cache.json`) keyed by file `(mtime, size)` that stores `first_user_message`; an unchanged file is never re-parsed; `CACHE_SCHEMA_VERSION = 3` gates whole-cache invalidation, and `load_cache_file` already drops individual stale entries with a targeted filter (`has_legacy_claude_identity`). So a tag-list change alone does not re-derive cached first messages (V2: 164 live rows start with a new tag, 161 of them in files that will not change by themselves; a schema bump would re-parse all 17.6 GB of transcripts at boot) | `crates/freshell-sessions/src/directory_index.rs:1128`, `:2448-2450`, `:2688`, `:2738-2779` |
| G43 | Tests that pin "the inherited OneCLI proxy wins over a configured key": `session_name_onecli_route_omits_direct_key`, `onecli_missing_credential_retries_with_direct_key` and neighbors; the worker test `onecli_missing_credential_worker_fallback_saves_ai_name`; the e2e OneCLI journey, whose `bootJourney` sets `GOOGLE_GENERATIVE_AI_API_KEY` to a sentinel or a key next to the proxy and asserts `hasApiKey:false` | `crates/freshell-server/src/ai_title.rs:1034-1200`; `crates/freshell-server/src/session_name_generation_tests.rs:718`; `test/e2e-browser/helpers/unified-agent-names-modes.ts:75-83`, `:251-287` (used by `unified-agent-names-freshcodex.spec.ts:24`) |
| G44 | The current client rewrites the per-window sidecar `freshell.layout.pre-migration-raw.v1.<windowId>` during its own storage migration, so it is not genuine pre-migration evidence (on the live copy it produced 5 winning "OpenCode agent" records); the bare `freshell.layout.pre-migration-raw.v1` key is not written by the current client | `src/store/storage-migration.ts:318-331`; `src/store/window-layout-keys.ts:53`, `:75` |
| G45 | Contract: "switching conversations adopts the new session's name". The identity upsert moves a durable `Session` ref onto the new session but never touches the registry's naming binding, so the row keeps showing the old session's name | `docs/plans/2026-09-16-unified-agent-names.md:19`; `crates/freshell-ws/src/identity.rs:314-330`; registry binding set only in `bind_pending_naming` `:640-646` |
| G46 | `observe_native_live` stamps each observation with the store's CURRENT verified location revision at call time, so a retry that calls it again gets a new stamp | `crates/freshell-freshagent/src/naming.rs:608-639` |
| G47 | A Rust-only, env-read-once test seam for e2e already exists (`FRESHELL_GEMINI_BASE_URL`) | `crates/freshell-server/src/main.rs:965-972` |
| G48 | The JSONL writer's scrubber redacts the exact `AUTH_TOKEN` plus a common-secret regex whose Gemini arm is `AIza[0-9A-Za-z_-]{20,}` only; Dan's Settings key is 53 characters in the `AQ.` form (V1), which it would not redact | `crates/freshell-runtime-observability/src/lib.rs:61-69`, `:92-125`; tests `crates/freshell-server/src/logging.rs:495-535` |
| G49 | **V1 (live, read-only GETs):** with Dan's key, Gemini answers 200 both directly and through the inherited OneCLI gateway (identical bodies; the gateway decrypts TLS with its own CA, which the live process trusts through `SSL_CERT_FILE`). Through the gateway: no key → 403 `access_restricted`; a bad key → **400** with the same OneCLI `access_restricted` body (Google's `API_KEY_INVALID` is hidden); a valid key and an unknown model → 404 with Google's own body. Without `SSL_CERT_FILE` the proxied request fails `is_connect()` with an `UnknownIssuer` certificate error in its source chain. The live process has no `GOOGLE_GENERATIVE_AI_API_KEY`; since its start the live log shows 25 `generation_failed: gemini http 403` and 0 successes | `scratchpad/lb-validate/report-0.md`; `scratchpad/lb-validate/V1/` |
| G50 | The activity apply re-checks the strict raise: `activity_decision` applies `plan.offer_fallback` through `offer_mut`, which accepts an automatic offer only when `source_rank(source) > source_rank(record.source)`; so a pre-check that plans a self-heal would be refused at apply time, every pass. The bind's explicit-open hook flips an Idle, never-attempted series to Eligible with whatever excerpt it stored | `crates/freshell-server/src/session_names.rs:2756-2765`, `:2183`; bind hook `:2600-2614` |
| G51 | Reconstructed managed panes: `managedTerminalContent` sets a `sessionRef` only when the soul has `nativeSessionId`, and never sets `nameRef`/`namingHandle`; the inventory has no naming handle. Managed runtime covers shell and OpenCode only; OpenCode learns its session id later, and `terminal.session.associated` writes that `sessionRef` into every pane with the matching `terminalId`, reconstructed ones included. A tab added with no title stores `Tab N`, which `getTabDisplayTitle` treats as a default | `src/lib/recovery/managed-runtime-recovery.ts:119-145`; `crates/freshell-agent-runtime/src/lib.rs:83-175`; `crates/freshell-ws/src/opencode_association.rs:314`; `src/App.tsx:1608-1625`; `src/lib/terminal-session-association.ts:162`; `src/store/tabsSlice.ts:358`; `src/lib/tab-title.ts:19-38` |
| G52 | `extract_user_authored_text` also feeds Claude's `user_message_count`, which drives `is_non_interactive` (at most 1 counted message) and the sidebar's default hide-non-interactive filter; V5 found 1 of 32 Claude sessions on this host would flip once the command tags are skipped | `crates/freshell-sessions/src/parse/claude.rs:353-358`, `:532`; `src/store/selectors/sidebarSelectors.ts:729-732` |
| G53 | **V3:** the host's Docker supervisor lane works when a managed case runs alone (a managed OpenCode parity case passed alone; the baseline's 7 failures ran several managed rigs at once). `runtime-terminal-continuity-rust.spec.ts` is `test.describe.serial`; its P2-G01 fails on `main` (after a graceful web restart the managed shell's `terminal.attach` gets `INVALID_TERMINAL_ID` and the client starts a new terminal), so later cases are skipped; its P2-G04 needs Dan's OneCLI grant files and makes paid model calls. Playwright 1.58.2 needs `chromium_headless_shell-1208` | `test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts:164-165`, `:323-329`; `test/e2e-browser/playwright.config.ts:24-36`; `src/components/TerminalView.tsx:6695-6710`; `scratchpad/lb-validate/report-3.md`, `scratchpad/lb-validate/v3/` |
| G54 | Rust seams for a restart-level managed naming test: `TerminalRegistry::set_managed_controller`; the in-crate lookup-only fake controller pattern; the reconcile adopt path; the integration tests' `NamingProbeSink`; the in-process WebSocket harness of `pane_reconcile.rs` | `crates/freshell-terminal/src/registry.rs:4608`, `:4646-4676`; `crates/freshell-ws/src/terminal.rs:3635-3660`, `:8460-8490`; `crates/freshell-ws/tests/common/mod.rs:385`; `crates/freshell-ws/tests/pane_reconcile.rs:102-118` |

## Decisions and exact cross-task interfaces

### Name evidence (Task 1)
- `shared/name-evidence.ts`:
  `isDefaultOrDerivedName(name: string, ctx?: { cwd?: string; provider?: string; mode?: string }): boolean`
  and `isProviderPlaceholderTitle(provider: string, title: string): boolean`.
- `crates/freshell-sessions/src/name_evidence.rs` with the same two functions
  (`is_default_or_derived_name(name, &NameEvidenceContext)`,
  `is_provider_placeholder_title(provider, title)`), re-exported from the crate
  root. It calls the existing `is_opencode_placeholder_title`
  (`parse/opencode.rs:35`).
- A name is default/derived when, after trimming: it matches `^Tab \d+$`; it
  equals the basename of `ctx.cwd` (only when a cwd is supplied); it is a
  provider or mode label (`Claude`, `Claude CLI`, `Codex`, `Codex CLI`,
  `OpenCode`, `Shell`, `Freshclaude`, `Freshcodex`, `Freshopencode`,
  `Kilroy`, `Gemini`, `Kimi`, `Amplifier`, with optional `Recovered ` prefix
  and/or ` agent` suffix, case-insensitive); it is `Recovered`, `Untitled` or
  `Tab`; it is a provider placeholder (OpenCode `New session - <ISO>`,
  `Child session - <ISO>`, `New Session - <ISO>`); or it begins with a tool
  wrapper tag (`<tag>` or `<tag ` for a tag in the shared
  `SYSTEM_CONTEXT_LEAD_TAGS` list, which Task 5 extends). Only that
  leading-tag check is used, through a new
  `freshell_sessions::text::starts_with_context_tag(text)` (TS: no tag list
  exists client-side today, so `shared/name-evidence.ts` carries a copy of
  the list, kept in step by the shared fixture's wrapper rows, which both
  implementations must pass); the rest of `is_system_context` is NOT used,
  because it would also flag real names such as `$ cmd` or `1, …` (V5).
- **Where the folder comes from (G36).** Client: pane content `initialCwd`.
  Server: the session index row's `cwd` (sweep hydrate input and the sweep's
  `NameActivity.cwd`, G41) and the terminal row / `PendingNameInput.cwd`
  (create paths). Automation renames get the best-known folder for their
  target (Task 4, LB-B8): the terminal row's cwd for the pane, tab and
  terminal routes, the session index row's cwd for session-key routes.
  Imports, bind inputs and native observations carry no folder; those checks
  run with `cwd: None` and therefore recognize only folder-free patterns.
- One shared case table `test/fixtures/name-evidence/cases.json` is the test
  input of both implementations. (A `test/fixtures/**` change routes the
  pre-push gate to the full workspace; expected.)
- Used by: client candidate extraction (Task 2), bind collisions with
  import-owned records (Task 3), native observations, automation renames and
  the self-heal rule (Task 4), the first-message fallback (Task 5), the
  managed merge (Task 8). User-intent renames are never filtered.

### Import policy after migration (Tasks 2–3)
- Client: a device captures at most once, behind the durable marker
  `freshell.session-names.capture-done.v1` (separate prefix so the envelope
  enumerator never sees it). Genuine pre-migration sources are only the bare
  shared keys `freshell.layout.v3`, `freshell.layout.v3.bak`,
  `freshell.tabs.v2`, `freshell.panes.v2`, and the bare
  `freshell.layout.pre-migration-raw.v1`, AND only when the raw JSON carries
  no unified-names fields (no tab `nameSource`, no pane
  `nameRef`/`namingHandle`). Never `freshell.layout.v3.<windowId>` or its
  channels; never the per-window sidecar
  `freshell.layout.pre-migration-raw.v1.<windowId>`, which the current client
  rewrites during its own storage migration (G44); never from `crossTabSync`
  or machine-workspace restore.
- **Server, once `migration.completed` is true, for every non-boot import:
  acknowledge every candidate id and write nothing.** No record is created or
  changed, no candidate id is stored, no backup file is written, and the
  document generation does not move. One INFO
  `session_names.import_ignored_after_completion {import_id, candidates}` per
  import id per process (an in-memory set bounds it). D1 permits this ("may *at
  most* create"); the report's RC1 fix 1.b recommends it.
- **Why not create at the lowest rank (the earlier draft).** A created
  `directory` record keeps nothing: the next sweep pass replaces it (the
  first-message fallback, or the self-heal hydrate re-offer for a folder
  name), and creating costs a 4.5 MB document write per import. Old browser
  tabs that stay open after the deploy keep sending imports until reloaded;
  acknowledge-only makes those sends free.
- Bind collision: an import-owned record (winning evidence still at its
  installed revision) whose source is `directory`, `first_message` or
  `provider_ai` loses to the pending record being bound ONLY when its name is
  default/derived (`is_default_or_derived_name`, `cwd: None`: bind inputs
  carry no folder, G36); the loser goes to recovery as today. Every other
  import-owned record (a real-looking label such as "ms-people-summit", a
  real first message) and every protected one keeps today's rank rule.
- Tie-break (pre-completion boot path only): `compare_classified_candidates`
  stops at scope; equal candidates compare `Equal`, and
  `apply_legacy_candidate` replaces only on a strict win, so the incumbent
  stays. `order_boot_legacy_candidates` keeps a candidate-id sort only to keep
  chunk membership stable (it decides batching, not the winner).

### Ranking and self-heal (Tasks 4–5)
| Source of the offer | Applies when the current record is | Result when refused |
|---|---|---|
| User rename (`nameIntent:"user"`) | anything | — (unchanged rule) |
| Freshell AI answer | below `freshell_ai` (every unprotected record, so the self-heal rule changes nothing here) | (unchanged rule) |
| Automation rename (omitted/`automatic` intent), recorded at `provider_ai` | `directory`, `first_message`, `provider_ai` (equal rank allowed) and text differs and is not a default or derived label, classified with the best-known folder for the target (terminal row cwd for pane/tab/terminal routes, session index row cwd for session-key routes; LB-B8), so a rename to the session's own folder name is refused, never applied and then healed | `outcome:{applied:false, reason:"protected_name"|"default_label"}`; same text → `{applied:true, reason:"unchanged"}` with `changed:false` |
| Provider-native observation (current location; not a placeholder or other default/derived label, folder-free patterns) | title differs from `last_native_title` (C4) AND the record is below `provider_ai` (raise), a self-heal record, or `provider_ai` when a baseline exists (`last_native_title` set) and the observed title differs from both the current name and that baseline. The FIRST observation of a record (`last_native_title == None`) only records the baseline at equal rank | provenance only (the baseline is still recorded) |
| First-message fallback (wrapper and other default/derived text excluded, RC12) | below `first_message`, or a self-heal record, for ANY activity reason that carries a first user message | no-op |
| Hydrate from the session index (sweep) | no record (today's insert); or a self-heal record (new; which rung may apply is below) | no-op |
| Post-migration browser import | never applies | acknowledged, nothing written |

**Self-heal rule (new; replaces the withdrawn repair tool).**
- A **self-heal record** is an unprotected record (`directory`,
  `first_message`, `provider_ai`) whose current name the Task 1 classifier
  recognizes: `is_default_or_derived_name(name, ctx)` with `ctx.provider` from
  the record's ref and `ctx.cwd` from the offer's own input — `NameActivity.cwd`
  (the sweep's index row, or the lane that reported the accepted input
  through `report_accepted_input`, `crates/freshell-freshagent/src/naming.rs:422-450`)
  and the hydrate input's index-row cwd; `None` (folder-free patterns only)
  for native observations, imports and pending→durable binds, whose inputs
  carry no folder (G36, G41).
- A self-heal record ranks below `directory` for every automatic offer
  (first-message fallback, native observation, hydrate from the index, AI
  generation answer). Concretely:
  - an offer whose own text is a real name (not default/derived under the
    same context) replaces it, whatever the offer's rank;
  - a default/derived offer never replaces a name, with one exception:
    hydrate's last rung (`directory_fallback_name`: the session's folder
    name, else the provider label) may replace a self-heal record whose source
    is above `directory`. After that the record is an ordinary `directory`
    record, so two default labels can never alternate;
  - the same text is always a no-op (no revision, no publish).
- `manual`, `legacy_protected` and `freshell_ai` records are never self-heal
  records. Automation renames are not affected by the rule (their own row
  above already allows equal rank).
- One pure predicate `self_heal_offer_applies(record, offer_name,
  offer_source, ctx) -> bool` in `crates/freshell-server/src/session_name_policy.rs`
  decides it. V2 confirmed the rule works with the sweep pre-checks only
  under five conditions, each with its own Task 4/5 test:
  - **C1 — apply what was planned.** `activity_pending` already runs
    `plan_activity` (G41); `plan_activity` gains the activity's `cwd` and
    routes its fallback rank check through the predicate, AND
    `activity_decision` applies `plan.offer_fallback` as decided instead of
    re-offering it through `offer_mut`'s strict raise (G50). Otherwise the
    pre-check says "pending" while the apply refuses, the name never heals,
    and every 5 s pass runs a locked full-document transaction per record.
  - **C2 — one hydrate plan.** `hydrate_indexed_pending`
    (`session_names.rs:933-940`, today a bare "no record" test) and the early
    return in `hydrate_indexed_decision` (`:3200-3212`) both call one new pure
    `plan_hydrate(document, &input) -> Option<(String, NameSource)>`: no
    record → today's ladder (insert, absorb unchanged); a self-heal record →
    the ladder's rung when the predicate allows it (replace; no series is
    created or absorbed on this path); the same text, or anything else →
    `None` (Read, and the pre-check reports no work).
  - **C3 — stored rank can decrease.** Healing moves `provider_ai` to
    `first_message` and `first_message` to `directory`. The two doc
    comments that argue from "a record's source rank never decreases"
    (`:911-932`, `:950-962`) are rewritten to say so and to state the
    remaining safety direction: a stale adopted view only delays work (a
    foreign writer — in practice only an older binary — storing a junk name
    is seen after the next refresh, the 2 s tick) and never loses it.
  - **C4 — native echoes never re-raise.** An observed native title equal
    to `last_native_title` is provenance only, also when it would raise
    rank. Without this, a native title equal to the folder name (not
    recognizable without a folder) could raise over a healed name on every
    echo while the sweep healed it back (0 live cases, but the loop is
    possible).
  - **C5 — the OpenCode first-message lookup sees the folder.**
    `needs_first_message_input(target, cwd)` takes the index row's folder,
    so a folder-named record counts as needing input, and the sweep's "no
    user message" memo persists across passes (keyed by session id + index
    `updated_at`), not only within one pass (Task 5).
- Where healing happens: every non-boot sweep pass feeds `IndexUserMessage`
  for every indexed session with a first message and re-checks hydrate
  (G41); live native observations; accepted user messages. Existing junk
  names therefore heal within the first sweep passes after deploy, or when
  a session is next seen, with no separate tool. Names that are not
  recognizable junk stay (Residuals). V2's estimate for the live data:
  about 190 one-time record rewrites in the first passes (141 Codex wrapper
  names → real first message, 16 → folder name, 4 Claude wrapper names, 19
  OpenCode records → provider title, 11 `provider_ai` folder/label names →
  first message), plus the re-absorb writes for the re-derived Codex
  sessions and the native baselines. The wrapper names heal only because
  Task 5 invalidates their stale parse-cache entries (G42), and the
  re-derived first messages do not start background AI naming (Task 5,
  re-absorb at rest).
- **Batched sweep writes (LB-B1).** Every transaction re-reads and rewrites
  the whole 4.5 MB document under a lock that waiters poll for at most 1 s
  (`session_names.rs:93-96`, `:1703-1727`), so ~190 back-to-back
  single-record commits could starve user renames and binds right after
  deploy. Instead, the sweep pass collects its maintenance work — self-heal
  replacements (activity fallback or hydrate rung), re-absorb-at-rest
  updates, and staged native baselines — and applies it in ONE store
  transaction per pass covering at most `SWEEP_MAINTENANCE_BATCH = 25`
  records (`sweep_maintenance_decision`, re-planning each item on the
  freshly read document with the same plan functions, publishing each
  changed record). Work beyond 25 waits for the next pass (≥ 5 s later), so
  the post-deploy burst is about eight writes spread over a minute, and
  renames and binds take the lock between passes. Inserts of new records
  and activities that arm generation keep today's per-row transactions.
  The pre-checks report which kind of work a row has, so the pass can sort
  it without transacting.
- Logging: the Task 12 `name_changed` event carries `self_heal: true` when
  an automatic native, first-message, hydrate or bind-collision offer
  replaces recognizable junk with a name whose source ranks the same or
  lower. A rank increase is `false`, even when it replaces junk; renames,
  AI answers, imports and adopted external changes are always `false`.

**Native observation details.**
- New internal field `NativeWriteState.last_native_title: Option<String>`
  (serde default; never on the wire). It is persisted whenever a valid
  current-location, non-placeholder title differs from it, so an echo of the
  same native title can never undo an automation or user rename, and never
  raises rank either (C4).
- **First observation sets the baseline.** Every existing record starts with
  `last_native_title == None`, and pre-deploy automation renames
  (`provider_ai`) were never written back to the provider (only `manual` and
  `freshell_ai` are writable), so the provider still reports its older title.
  The first observation therefore records the baseline and replaces at
  equal rank only when the record is a self-heal record; a raise from below
  `provider_ai` still applies as today. A baseline that changes nothing
  else never makes its own commit: the store stages it in memory and the
  next sweep maintenance batch (or the next real commit touching that
  record) persists it. Losing a staged baseline at a restart only means the
  next observation records it again (LB-B1).
- **Native observations never block an event relay (G14).** `observe_native_live`
  builds the `NativeNameObservation` once, stamping `location_revision` at
  observation time (G46), and makes one attempt inline; on
  `LockUnavailable`/`Persistence` it hands THAT observation to a per-sink
  background retrier (200 ms, then 1 s) that keeps only the LATEST
  observation per target, tagged with a per-target sequence. A retry
  re-submits the captured observation unchanged (never re-stamped), so if
  the provider location moved meanwhile it folds as stale (provenance only);
  a retry applies only if its sequence is still the latest, so an older
  title can never land after a newer one. The relay loop returns
  immediately.

**Automation rename outcome.**
- Wire (additive, optional): `SessionNameUpdate.outcome?: { applied: boolean; reason?: 'protected_name' | 'default_label' | 'unchanged' }`
  in `crates/freshell-protocol/src/session_names.rs:191-198` and
  `shared/session-names.ts:184-190`. Only rename responses set it; broadcasts
  never do. Rename convenience routes pass it through unchanged; the CLI and
  MCP read it at each route's actual nesting (freshagent routes:
  `data.sessionName.outcome`, G40; the implementer records each route's path
  in the Task 4 receipt).

### Generation capability (Task 6)
- **Route by credential (D5, as amended by Dan on 2026-10-22),** decided per
  attempt from the live key cell:
  1. **A key is configured** (`GOOGLE_GENERATIVE_AI_API_KEY`, else
     `settings.ai.geminiApiKey`, through the existing `AiKeyCell`, so a
     Settings save takes effect at the next attempt, G18) → **key route**:
     the key is always sent (`x-goog-api-key`) and wins over any OneCLI
     marker on the ambient proxy. The old "OneCLI first, key only on
     `credential_not_found`/`app_not_connected`" order (G16) is removed.
  2. else the ambient proxy carries a OneCLI marker → **inherited OneCLI
     route** (today's behavior: no key sent), with a boot WARN
     `session_names.generation_route_inherited_identity` (once) saying the
     server is borrowing the launching shell's OneCLI identity.
  3. else unavailable (no claims).
  Every route makes one request per attempt; there is no fallback between
  routes.
- **How the key route reaches Google (V1 + LB-B5/B6, resolved).** A
  request carrying a configured key goes DIRECT (a `reqwest` client built
  with `.no_proxy()`) when the ambient proxy for the Gemini URL carries the
  OneCLI marker (`has_onecli_authorization`, `ai_title.rs:471`): OneCLI is
  the launching agent's credential broker, its token may not outlive that
  agent, and a client-supplied key through it was only ever proven for GETs,
  while direct was proven on this host (G49). Otherwise the key route uses
  the normal client that honors the ambient proxy environment
  (`HTTPS_PROXY`/`NO_PROXY`, `reqwest::Client::new()` semantics), so hosts
  whose only way out is an ordinary proxy keep working. Requests with no
  key (the inherited OneCLI route) use the normal client as today. On Dan's
  host the key therefore never passes through the gateway. The boot log
  field `key_route_transport` (`direct` | `ambient_proxy`) says which.
- Failure classes (G49), checked in this order:
  - HTTP: **429 is `Throttled` first** (LB-B10: a quota answer through the
    gateway must not latch as a 15-minute `Capability`); then any non-2xx
    whose body is OneCLI-style JSON (a top-level string `error`, e.g.
    `access_restricted`, `credential_not_found`, `app_not_connected`) is
    `Capability{code: <that error>}`, checked before the remaining status
    rules because the gateway reports a bad key as **400**
    `access_restricted`; then 401/403/407 and Google `API_KEY_INVALID` are
    `Capability`; any other status is `Transient`/`Invalid` (unchanged
    consumption).
  - Transport: whether the request went through a proxy is computed for the
    request URL with the existing `GeminiProxyEnvironment`
    (`effective_proxy`/`bypasses_proxy`, `ai_title.rs:152-230`), and is
    always false on the direct key route. A rustls invalid-certificate
    error anywhere in the source chain is `Capability{proxy_tls}` through a
    proxy and `Capability{tls_untrusted}` otherwise; it is found by
    downcasting to `rustls::Error::InvalidCertificate` (walking `source()`
    and looking inside `std::io::Error::get_ref()`), never by matching
    message text, because `is_connect()` is also true for a refused
    connection. `freshell-server` adds `rustls` as a direct dependency at
    the version already in `Cargo.lock` (0.23.41, via reqwest) so the
    downcast type is the same one. Any other `is_connect()` error is
    `Capability{proxy_unreachable}` through a proxy (a CONNECT refused with
    407/403, a proxy that is down) and `Capability{direct_unreachable}`
    otherwise (latched, nothing consumed: a host that reaches Google only
    through its OneCLI proxy pauses naming with a WARN, Residual 19).
    Timeouts and everything else are `Transient`.
- **Log scrubbing (G48, LB-B13).** The JSONL writer redacts the currently
  configured key value itself (exact match) in addition to the patterns:
  the writer gains a shared live-secret set next to its `AUTH_TOKEN`
  secret, `main.rs` puts the key cell's value in it after `AiKeyCell::init`,
  and the Settings PATCH path refreshes it right after
  `apply_settings_key_forced` (`settings_store.rs:2139-2143`). The
  common-secret regex in `crates/freshell-runtime-observability/src/lib.rs:61-69`
  also gains the `AQ.` key form (`AQ\.[0-9A-Za-z_-]{20,}`) next to `AIza…`.
  Naming code still logs only statuses and codes.
- **Exhaustion moves from the claim to the fold (G17).** The claim increments
  `consumed` and sets `InFlight`, and never clears the excerpt. The fold
  decides: `Capability`/`Throttled` refund the start (consumed −1, attempt
  id/start removed, status Eligible, excerpt kept); `Empty`/`Failed` at the
  cap exhaust and clear the excerpt (today's end state). Boot recovery of an
  interrupted start already exhausts at the cap (`:3168-3171`), so a crash
  mid-attempt still ends exhausted.
- **Latches (in memory, with code).** `Capability` latches naming as
  unavailable until a re-probe time (default 15 min; Rust-only test seam
  `FRESHELL_NAMING_CAPABILITY_REPROBE_MS`) or a key change. `Throttled`
  latches the same way with a shorter, growing re-probe: 60 s, doubling per
  consecutive throttled probe, capped at 15 min, reset by any success or a
  key change (Rust-only test seam `FRESHELL_NAMING_THROTTLE_REPROBE_MS` sets
  the base). One probe attempt runs per window. While latched the worker
  claims nothing, so a refunded series cannot loop (load-bearing review
  LB-A14).
- Logs: WARN `session_names.generation_capability_unavailable {code, status, route}`
  once per transition (a 429 logs `code=throttled`); INFO
  `session_names.generation_capability_restored`; INFO at boot
  `session_names.generation_route_selected {route, onecli_marker, key_configured, key_route_transport}`
  (booleans and names only; never a key or URL); `session_names.generation_failed`
  gains `status` and `provider_code` fields.

### Client tab titles (Tasks 7–9)
- **D2 choice: mirror, not "no stored title".** A session-owned tab
  (`nameSource.kind === 'session'`) keeps `tab.title`, written only by a new
  middleware from the canonical record, without bumping `updatedAt` and
  without `titleSetByUser`. Justification: `title` is a required field in
  persisted layouts, the server layout mirror, the tabs registry, closed-tab
  snapshots and REST projections; removing it would touch every one of those
  schemas and old-client compatibility, while a mirror fixes all of them at
  once (they already copy `tab.title`) and keeps the last-known saved name
  for offline display. It is never name evidence because Task 2 stops reading
  live layouts.
- **The mirror writes only when a saved record is known (G33).** For each
  session-owned tab it resolves the source pane's ref
  (`resolvePaneNameRef(content)`) and reads `selectSessionNameRecord(state, ref)`.
  No record → no write; the tab keeps its last-known title. It never uses
  `selectScopedTabDisplayTitles`/`selectPaneDisplayName`, which fall back to
  provider labels. New selector `selectSessionTabSavedNames(state): Record<tabId, string>`
  (records only) in `src/store/selectors/sessionNameSelectors.ts` next to the
  existing one; the registry overlay switches to it too (so the registry no
  longer advertises a fallback label for a session-owned tab whose record is
  not loaded).
- Module name: `src/store/savedNameTabTitleMirror.ts`
  (`savedNameTabTitleMirrorMiddleware`). It differs from the existing
  `src/store/sessionTitleMirror.ts`, which copies session-directory titles
  into NON-scoped pane titles; the contract doc's pane-title section says so.
- One gate `canWriteLegacyTabTitle(state, tabId)` in new
  `src/lib/tab-title-ownership.ts`: false when the tab is session-owned. Every
  legacy writer in G23 calls it; the `tab.create` UI command does not set
  `titleSetByUser` when the created pane content is scoped (its title is a
  provisional display until the record arrives).
- `updateTab` payload gains optional `touchUpdatedAt?: boolean` (default
  true); display-only refreshes pass `false`.

### Terminal naming bind (Task 10)
The core lives in `freshell-freshagent` so both doors can call it (G35):
```rust
// crates/freshell-freshagent/src/terminal_name_binding.rs
pub enum NamingBindOutcome { Bound(SessionNameRecord), BoundNoRecord, NotScoped, Deferred(String) }
pub trait TerminalNameBinder: Send + Sync {
    /// Record the terminal's naming ref in the door's identity table.
    fn set_name_ref(&self, terminal_id: &str, name_ref: &SessionNameRef);
    /// The durable (provider, session id) the door knows for this terminal, if any.
    fn durable_session_of(&self, terminal_id: &str) -> Option<(String, String)>;
}
pub struct NamingBindHint { pub mode: String, pub cwd: Option<String>, pub resume_session_id: Option<String>, pub naming_handle: Option<String> }
pub async fn bind_terminal_naming_from_identity(
    sink: &NameSink, registry: &TerminalRegistry, binder: &dyn TerminalNameBinder,
    terminal_id: &str, hint: NamingBindHint,
) -> NamingBindOutcome
```
- `freshell-ws` implements `TerminalNameBinder` over its identity registry
  (thin wrapper in new `crates/freshell-ws/src/terminal_naming.rs`); the REST
  door implements it over whatever `terminal_tabs.rs:3491-3545` uses today to
  record the binding.
- It resolves the target (durable scoped session if known, else the pending
  handle), sets the identity and registry bindings together, then reads the
  record. "Read failed" and "no record" are separate arms (today both are
  `None`, G26): read failure retries on `LockUnavailable`/`Persistence`
  (50 ms, 250 ms, 1 s) and then returns `Deferred` with the binding kept;
  "no record" with a persisted handle goes to the pending path; `ensure_pending`
  gets the same bounded retry, and on persistent failure the row is still
  bound to the pending ref and marked for the tick (it is never left
  unbound). A recovery create accepts the pending answer only if the
  handle is still pending or resolves to the intended durable session. A
  handle already spent on another session never moves the row to that
  session: the intended durable binding stays, without a cached name.
  `pane.reconcile.request` carries the pane's optional `namingHandle`
  through managed-row adoption, so a zero-turn pane can rejoin its existing
  pending name after a server restart. It fills
  `registry.update_session_name` and sets the row title to the saved name
  or `mode_label(mode)` (never "Shell" for an agent mode).
- The 2 s tick reconciles: rows whose identity ref differs from the registry
  ref; bound rows whose name cache is empty; and scoped-mode rows with NO ref
  (it runs `ensure_pending` for them).
- **Conversation switch adopts the new session's name (existing contract,
  G45).** When the identity upsert retargets a terminal from session A to
  session B, the registry binding moves to B together with the identity ref
  (the helper sets both; the tick's "identity ref ≠ registry ref" reconcile
  is the backstop), and the row adopts B's record: B's saved name if B has a
  record; otherwise the row title is `mode_label(mode)` and the pane shows
  its no-saved-name fallback label until B's record is created by the
  normal paths (the sweep's hydrate ladder: provider title → first message
  → folder; then the first-message fallback and AI naming). On this path
  the helper never takes the "no record → pending" arm: the terminal's
  pending handle was already bound to A, so falling back to it would show
  A's name again. The retarget itself creates or changes no record, and A's
  record is untouched.
- Association/materialization notifications carry the authoritative
  `nameRef`. The client adopts it together with the session identity and
  releases a spent pending handle when the conversation changes, even
  immediately after a reload before redirect records have loaded. A
  zero-turn pane whose authoritative ref is still pending keeps that ref
  and its pre-durable saved name.

### Store reads (Task 11)
- `Adopted` gains `stamp: DocumentStamp { len: u64, mtime_ns: i128, file_id: Option<(u64, u64)> }`.
  `file_id` is `(dev, ino)` from `std::os::unix::fs::MetadataExt` under
  `#[cfg(unix)]` and `None` elsewhere (the Windows file-index APIs in std are
  unstable; no new crate). On Windows the stamp is `len` + 100 ns `mtime`.
- `SessionNames::adopt_external_if_changed() -> NameFuture<bool>`: stat the
  document; if the stamp equals the adopted one AND the last full check is
  younger than 30 s, return `false` without a lock; otherwise run the existing
  locked full-read adoption. The 30 s full check bounds staleness for the
  rare case a replace keeps length and mtime (coarse filesystems).
- `get` serves from the adopted view after `adopt_external_if_changed`; only
  an unestablished store (generation 0) falls back to the locked path.

### Name-change event (Task 12)
INFO `session_names.name_changed` with fields `name_ref`, `old_name`,
`old_source`, `old_revision`, `new_name`, `new_source`, `new_revision`,
`cause` (`import`|`native_observation`|`first_message_fallback`|`generation`|`manual_rename`|`automation_rename`|`bind`|`bind_collision`|`ensure_pending`|`hydrate`|`adopted_external`),
`self_heal` (true when an automatic native, first-message, hydrate or
bind-collision offer replaces recognizable junk at the same or lower
source rank; rank increases, renames, AI answers, imports and adopted
external changes are false), plus
`import_id`/`evidence_key`/`series` when applicable. Emitted once per
accepted visible change, after the durable commit. A conversation switch
changes no record, so it emits no `name_changed`; Task 10 logs the binding
move itself.

### Task order and dependencies
| Phase | Task | Depends on | Validation results it applies |
|---|---|---|---|
| Stop new damage | 1 Name-evidence classifier | — | V5 (leading-tag check only) |
| | 2 Client import shutdown + envelope cleanup + flush never blocked (D1 client, D10) | 1 | — |
| | 3 Server: acknowledge-only imports after completion; default-label bind collisions (D1 server) | 1 | — |
| Ranking, self-heal & fallback | 4 Native placeholders, native replacement, automation outcome, self-heal rule (D3) | 1 | V2 (C1–C4); LB-B1 (batched sweep maintenance, staged baselines), LB-B8 (folder-aware automation renames) |
| | 5 First-message fallback on every first message; wrapper text excluded (D4, RC12) | 1, 4 | V2 (cache invalidation, re-absorb at rest, prompt-input guard, C5), V5 (tag set, fixture shape); LB-B7 (interactive pin), LB-B11 (per-entry rules stamp) |
| | 6 Generation routing, capability classification and pause (D5 as amended) | — | V1; LB-B5/B6 (direct key route when the proxy is OneCLI's), LB-B10 (429 first), LB-B13 (live-key scrubbing) |
| Client models | 7 Saved-name tab title mirror (D2) | 2 | — |
| | 8 Managed-runtime merge never writes names (D6) | 1, 7 (the mirror must read records only before reconstructed agent tabs rely on it) | V3 (new local-only spec), V4 (scoped-only session ownership); LB-B3 (stored-state assertions, red receipts), LB-B4/B14 (fallbacks) |
| | 9 New-window rebuild keeps pane titles and flags (D7) | 7 | — |
| | 14 Heal stored provider-label tab titles; registry opens keep pane names (added after the Stage 2 reviews; Residual 23, Task 9 receipt open concern 3) | 1, 7, 8, 9 | — |
| Server binding | 10 Bind naming on every terminal row path; a conversation switch adopts the new session's name (D8) | — | V3 (restart naming at Rust integration level); LB-B2 (every adopt/create entry) |
| Store perf | 11 Lock-free reads and a cheap cross-process peek (D9) | — | — |
| Observability | 12 Name-change events; codex proxy `RepairTrigger` log spam diagnosed and bounded (D11) | 3–6, 10 | — |
| Finish | 13 Contract doc, e2e roll-up, build, code review, gate, PR and merge | all | V3 (local-only run rules), all results recorded |

---

### Task 1: Shared default/derived name classifier

**Intent:** one definition of "this text is a default or derived label, not a
name", used everywhere name evidence is accepted and by the self-heal
rule (D1, D3).

**Files:**
- Create: `shared/name-evidence.ts`
- Create: `crates/freshell-sessions/src/name_evidence.rs` (export from `crates/freshell-sessions/src/lib.rs`)
- Create: `test/fixtures/name-evidence/cases.json`
- Create: `test/unit/shared/name-evidence.test.ts`
- Create: `crates/freshell-sessions/tests/name_evidence.rs`
- Modify: `crates/freshell-sessions/src/text.rs:135-154` (extract the leading
  `<tag[>\s]` branch of `is_system_context` into
  `pub fn starts_with_context_tag(text: &str) -> bool`; `is_system_context`
  calls it, so its behavior is unchanged)

- [ ] **Step 1: Write the failing tests.**
  - `cases.json`: ≥40 rows `{name, ctx, expected}` covering `Tab 7`, ` Tab 12 `,
    `Tab` , folder basename with `ctx.cwd:"/home/dan/code/freshell"` →
    `freshell`, the same `freshell` with no `ctx.cwd` → NOT default (pins the
    folder-free limit), `OpenCode agent`, `Shell agent`, `Recovered Claude agent`,
    `Claude CLI`, `codex cli` (case), `New session - 2026-10-20T00:09:25.350Z`,
    `Child session - …`, `New Session - …` (legacy capital S), `Untitled`,
    and true names that must NOT match: `Tab bar fix`, `freshell refactor`,
    `Fix the OpenCode agent crash`, `New session - planning` (not ISO),
    `main cleanup`, `LotL`, `ms-people-summit`, and the two V5 guards for the
    leading-tag-only rule: `$ ls -la` and `1, 2, 3` → NOT default (the rest
    of `is_system_context` would flag them). `<environment_context>…` →
    default (an existing tag). (The RC12 wrapper-tag rows are added in
    Task 5, when the tags exist.)
  - `test/unit/shared/name-evidence.test.ts`:
    `it('classifies every shared fixture case exactly as expected')` (loops the
    table, reports the failing row) and
    `it('treats provider placeholders per provider only')` (`opencode` +
    placeholder → true; `claude` + same text → false).
  - `crates/freshell-sessions/tests/name_evidence.rs`:
    `shared_fixture_cases_match` (reads
    `concat!(env!("CARGO_MANIFEST_DIR"), "/../../test/fixtures/name-evidence/cases.json")`)
    and `opencode_placeholder_reuses_directory_index_predicate`.
- [ ] **Step 2: Run red.** `pnpm run test:vitest run test/unit/shared/name-evidence.test.ts --config config/vitest/vitest.config.ts`
  and `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-sessions --locked --test name_evidence`.
  Expected: fail to compile/import (module missing).
- [ ] **Step 3: Implement** both modules per "Name evidence" above. TS imports
  use `.js` extensions where NodeNext requires them.
- [ ] **Step 4: Run green** (same commands).
- [ ] **Step 5: Refactor.** Make the directory index's placeholder use
  (`crates/freshell-sessions/src/parse/opencode.rs:1014`) and the client
  `tab-title.ts` `^Tab \d+$` check use the shared functions so there is one
  definition per language; re-run the existing tests of those files
  (`~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-sessions --locked opencode`,
  and the existing `getTabDisplayTitle` cases, located with
  `grep -rln getTabDisplayTitle test/unit`, through
  `pnpm run test:vitest run <those paths> --config config/vitest/vitest.config.ts`).
- [ ] **Step 6: Commit** `feat(names): shared default-label classifier`.

### Task 2: Client import shutdown, envelope cleanup, flush never blocked (D1 client, D10)

**Intent:** the browser stops sending its current tab and pane titles as name
evidence, deletes the migration copies it no longer needs, and can never
block a layout save on evidence capture.

**Files:**
- Create: `src/lib/legacy-name-capture-policy.ts` (`isGenuinePreMigrationSource(key, raw)`, `runOneTimeLegacyCapture(storage)`, `purgeObsoleteEnvelopes(storage)`, `markCaptureDone(storage)`, `isCaptureDone(storage)`)
- Modify: `src/lib/session-name-migration.ts` (module-load call at 889-893 → `runOneTimeLegacyCapture`; delete `captureLegacyLayoutEnvelope` 299-326 and `ensureLegacyNameCapturesForFlush`/`captureWriteFailed` 77-84, 346-357; `markAcknowledged` deletes the envelope; `submitPendingLegacyNameImports` marks done when nothing is pending; `extractEnvelopeCandidates` 482-630 skips default/derived labels with `ctx.cwd` from pane content `initialCwd`, and skips session-owned tabs' `title` entirely)
- Modify: `src/store/crossTabSync.ts:443-453` (remove capture)
- Modify: `src/lib/machine-workspace.ts:147-155` (remove capture)
- Modify: `src/store/persistMiddleware.ts:658-671` (remove the deferral gate)
- Modify: `src/store/store.ts:162-196` (submission only while capture is not done)
- Tests: rewrite `test/unit/client/lib/session-name-migration.test.ts` cases at :148, :209, :243, :269 and the taxonomy case at :686 (they pin the removed behavior); rewrite `test/unit/client/store/persistFlushCaptureGate.test.ts:97`; update the capture assertion near `test/unit/client/store/crossTabSync.test.ts:3060`; create `test/unit/client/lib/legacy-name-capture-policy.test.ts`.
- E2e: create `test/e2e-browser/specs/name-import-shutdown-rust.spec.ts` (scenarios A–C below; scenario D lands in Task 5) and `test/e2e-browser/specs/name-storage-quota-rust.spec.ts` (RC10, see the e2e matrix).

- [ ] **Step 1: Write the failing unit tests** (`legacy-name-capture-policy.test.ts`
  and the rewritten cases):
  - `it('never captures a live per-window layout key, its .bak or its fresh-agent backup')`:
    seed `freshell.layout.v3.layout-window-a`, `….bak`,
    `….backup-before-fresh-agent-centralization`; run; assert zero
    `freshell.session-names.migration.v1.*` keys and no import request
    (mock `api.post`).
  - `it('never captures the per-window pre-migration sidecar')`: seed
    `freshell.layout.pre-migration-raw.v1.layout-window-a` holding a
    pre-names raw whose scoped tab is titled `OpenCode agent` (the shape the
    current client writes, G44); run; zero envelopes, zero requests. The
    bare `freshell.layout.pre-migration-raw.v1` key is still captured (covered
    by the next case's source list).
  - `it('captures a genuine bare legacy layout once, then marks the device done after acknowledgment')`:
    seed `freshell.layout.v3` with a pre-names raw (no `nameSource`); run, submit
    (mock 200 with all candidate ids), assert envelope deleted, done marker
    present; run again with a changed bare key → no new envelope, no request.
  - `it('ignores a bare legacy key whose raw already carries unified-names fields')`.
  - `it('a device with prior envelopes or ack markers becomes done without resubmitting live-layout envelopes')`:
    seed an acked envelope + an unacked envelope whose `storageKey` is
    `freshell.layout.v3.layout-window-b`; run; assert both envelopes and the
    ack marker are deleted, done marker set, zero requests.
  - `it('a sibling window layout write never captures or submits')`
    (crossTabSync storage event with a changed per-window raw; assert no
    envelope, no `api.post`).
  - `it('machine-workspace restore performs no legacy capture')` (in
    `test/unit/client/lib/machine-workspace.test.ts`).
  - `it('extracts no candidate from default or derived labels')`: genuine
    legacy raw where a scoped tab is titled `Tab 7`, `freshell` (cwd basename),
    `OpenCode agent`, `Claude CLI`; assert `prepareLegacyNameImports` yields
    zero candidates; a real label `Billing bug` still yields one.
  - `persistFlushCaptureGate.test.ts`: `it('a quota-failing capture never blocks the layout flush')`
    (make `setItem` throw for `freshell.session-names.*` keys only; dispatch a
    tab rename; assert the layout key was written and a structured
    `legacy_name_capture_failed` error was logged).
- [ ] **Step 2: Write the failing e2e (scenarios A–C)** in
  `name-import-shutdown-rust.spec.ts`, driven by `bootUnifiedNamesServer({ mode: 'claude', gemini: <fake returning 403> })`
  (extend `startFakeGemini` with `opts.status?: number` and
  `opts.body?: unknown`), real pane-picker create, `sendFirstMessage`,
  `page.on('request')` counting `POST /api/session-names/import`, and
  `readRecord` for the server truth:
  - A `reload keeps the saved name and sends no import`: after the first message
    settles, read the record (name N, revision R); `page.reload()`; assert zero
    import POSTs, record still N at R, tab label N.
  - B `a second window keeps the saved name`: `context.newPage()` (new
    sessionStorage → new window id, shared localStorage); same assertions in
    both pages.
  - C `two windows with different stale tab titles never change the name`:
    `addInitScript` seeds two per-window keys whose session-owned tab titles
    are `Tab 23` and `ms-people-summit` for the same session; open both,
    reload each three times; record name and revision never change.
- [ ] **Step 3: Run red.** `pnpm run test:vitest run test/unit/client/lib/legacy-name-capture-policy.test.ts test/unit/client/lib/session-name-migration.test.ts test/unit/client/store/persistFlushCaptureGate.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/lib/machine-workspace.test.ts --config config/vitest/vitest.config.ts`
  and `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e --project=chromium test/e2e-browser/specs/name-import-shutdown-rust.spec.ts test/e2e-browser/specs/name-storage-quota-rust.spec.ts`.
  Expected red: envelopes captured from per-window keys, flush deferred,
  e2e A sees ≥1 import POST and (as reproduced) the name becomes `Tab N`.
- [ ] **Step 4: Implement.** Policy module per "Import policy after
  migration". `runOneTimeLegacyCapture`: done → purge acked/obsolete
  envelopes and return; else purge envelopes whose source is not genuine
  (never submit them), delete acked envelopes and markers; if a prior capture
  ever happened (ack markers or envelopes existed) and nothing genuine is
  pending → mark done; else capture genuine sources once (no source → mark
  done). Capture write failure logs `log.error('legacy_name_capture_failed', { storageKey, reason })`
  and never sets any flush gate. Submission marks done after the last
  acknowledgment. Remove the three capture call sites and the flush gate.
- [ ] **Step 5: Run green** (both commands).
- [ ] **Step 6: Refactor.** Remove now-dead exports (`captureLegacyLayoutEnvelope`,
  `registerLegacyNameSubmitGate`, `resetLegacyNameCaptureFailureForTests`) and
  their imports; `session-name-migration.ts` must end smaller than 893 lines.
  Fix the `stripSessionOwnedTabFreezeFlags` comment once Task 7 lands (note
  it in Task 7). Re-run Step 3 commands plus `pnpm run typecheck`.
- [ ] **Step 7: Commit** `fix(names): capture legacy names once per device and never block layout saves`.

### Task 3: Server acknowledges browser imports after completion without writing; default-label bind collisions (D1 server)

**Intent:** once the one-time consolidation is complete, a browser import
changes nothing and costs nothing; an import-owned default label ("Tab 4",
"OpenCode agent") never wins a bind collision, while other imported names
keep today's rank rule; window ids never decide a name.

**Files:**
- Create: `crates/freshell-server/src/session_name_import_policy.rs` (`post_completion_acknowledge(input) -> LegacyImportResult`, `is_import_owned(document, key) -> bool`, `import_owned_label_loses_bind(document, key) -> bool` = import-owned AND unprotected AND `is_default_or_derived_name(name, cwd: None)` from Task 1, the per-process logged-import-id set)
- Create: `crates/freshell-server/src/session_name_import_policy_tests.rs`
- Modify (wiring): `crates/freshell-server/src/session_names.rs` — `import_legacy_decision` 4003-4104: when `document.migration.completed && !trusted_boot`, return `Decision::Read(post_completion_acknowledge(&input))` BEFORE the backup write (`:4029`) and the ack push (`:4053-4057`); `compare_classified_candidates` 3682-3712 ends at scope; `apply_legacy_candidate` 3836-3851 keeps strict-win; `bind_pending_decision` 2537-2553 consults `import_owned_label_loses_bind`
- Modify: `crates/freshell-server/src/session_names_tests.rs`, `crates/freshell-server/src/session_name_routes_tests.rs` (cases that pinned tie-break order or post-completion application)

- [ ] **Step 1: Write the failing tests** (`session_name_import_policy_tests.rs`, real `SessionNames` on a temp data dir, migration completed through `complete_legacy_migration`):
  - `post_completion_import_writes_nothing`: one existing session record
    (`directory` "work") and one session with no record; import candidates
    `provider_ai` "Tab 4" (existing session), "Billing bug" (no-record
    session), a canonical pending target and a derived `legacy-pending`
    handle → every candidate id acknowledged; existing record unchanged
    (name, source, revision); no record created for either session or
    either pending target; document generation unchanged; the import backup
    directory gained no file.
  - `post_completion_reimport_stores_no_candidate_ids`: the same import sent
    three times → generation unchanged every time and
    `acknowledged_candidate_ids` did not grow (the 4.5 MB rewrite stops).
  - `post_completion_import_never_raises_rank`: existing `first_message`
    record; candidate claims `legacy_protected` (flag evidence) → unchanged.
  - `post_completion_import_logs_once_per_import_id` (capture `tracing`
    output with the crate's existing log-capture helper; same import id
    twice → one INFO `session_names.import_ignored_after_completion`).
  - `import_owned_default_label_loses_a_bind_collision`: before completion a
    boot import installs "Tab 4" at `provider_ai` on `session:claude:X`;
    complete; pending handle P has directory "work"; bind P→X → record
    "work", loser in recovery with reason `bind_collision_loser`.
  - **Pinning test** `import_owned_real_label_keeps_the_rank_rule`: same
    setup with "ms-people-summit" → the durable record keeps
    "ms-people-summit" (`provider_ai` outranks the pending `directory`
    record), exactly as today.
  - **Pinning test** (pre-completion boot path; short)
    `equal_rank_boot_candidates_keep_the_incumbent`: migration-owned record
    installed from window `pii…`; an equal-rank, equal-scope candidate from
    window `mn0…` → incumbent kept; swapped spelling → incumbent kept. Red
    today because the evidence key decides.
  - Route test in `session_name_routes_tests.rs`:
    `import_route_after_completion_acknowledges_without_writing` (HTTP POST →
    200, `acknowledged` lists ids, generation unchanged, no backup file).
- [ ] **Step 2: Run red.** `pnpm run test:server session_name_import_policy`
  and `pnpm run test:server session_name_routes`. Expected: creates,
  replacements, stored ids and backup files happen today; tie test flips
  with key order.
- [ ] **Step 3: Implement** per "Import policy after migration".
- [ ] **Step 4: Run green**, then the whole naming suite:
  `pnpm run test:server session_name`.
- [ ] **Step 5: Refactor.** Update the doc comments that promise "a later
  previously-offline import compares against this retained evidence with the
  same deterministic total order" (`session_names.rs:286-296`) and the
  tie-break comments; the pre-completion path is unchanged apart from the
  tie-break.
- [ ] **Step 6: E2e.** Add scenario `server ignores a forced stale import` to
  `name-import-shutdown-rust.spec.ts`: seed
  `freshell.session-names.migration.v1.<id>` holding a per-window raw with
  "Tab 23", clear the done marker (forcing an old-client-style send); assert
  the import POST returns 200, the record and its revision are unchanged, and
  the server log has one `import_ignored_after_completion` line.
- [ ] **Step 7: Commit** `fix(names): acknowledge post-migration imports without writing`.

### Task 4: Native placeholders, native replacement, automation outcome, self-heal (D3)

**Intent:** OpenCode's temporary "New session - <time>" title is never saved;
a provider's real, changed title can replace an older automatic provider-level
name once a baseline exists; automation renames say whether they applied;
observing a title never stalls an event stream; a saved name that is
recognizable junk gives way to the next real automatic name (the self-heal
rule), and names a person chose are never touched.

**Files:**
- Create: `crates/freshell-server/src/session_name_policy.rs` (`native_offer_decision(...)`, `automation_rename_decision(...)`, `self_heal_offer_applies(record, offer_name, offer_source, ctx)`, `plan_hydrate(document, &input)`) and `crates/freshell-server/src/session_name_policy_tests.rs`
- Create: `crates/freshell-server/src/session_name_sweep_batch.rs` (`SWEEP_MAINTENANCE_BATCH = 25`, the `SweepWork` kinds the pre-checks report, `sweep_maintenance_decision` applying ≤ 25 heal/re-absorb/baseline items in one transaction, the in-memory staged-baseline map) + tests; wiring in `crates/freshell-server/src/auto_title_sweep.rs` `run_auto_title_pass` (`:385`): collect maintenance items during the row loop, one batch call after it
- Create: `crates/freshell-freshagent/src/native_observation_retry.rs` (latest-observation-per-target background retrier; it holds the `NativeNameObservation` that `observe_native_live` built, location stamp included, and re-submits it unchanged)
- Modify (wiring): `crates/freshell-server/src/session_names.rs` — `observe_native_decision` 2802-2930 calls the policy (placeholder or default label → provenance only; first observation records `last_native_title` as the baseline; self-heal); `rename_decision` 2427-2464 delegates the automatic branch; `NativeWriteState` gains `last_native_title`; `plan_activity` 2651-2727 takes the activity's `cwd` and its fallback rank check calls `self_heal_offer_applies`; `activity_decision` 2729-2741 passes `cwd` (bound as `_cwd` today) and, at `:2756-2765`, applies `plan.offer_fallback` as planned instead of through `offer_mut`'s strict raise (C1, G50); `activity_pending` 963-976 passes `input.cwd`; `hydrate_indexed_pending` 933-940 and the early return in `hydrate_indexed_decision` 3200-3212 call `plan_hydrate`; the pre-check doc comments 911-932 and 950-962 are rewritten per "Self-heal rule" (C3: stored rank can decrease; a stale view only delays)
- Modify: `crates/freshell-protocol/src/session_names.rs:191-198` and `shared/session-names.ts:184-190` (optional `outcome`)
- Modify: rename callers so the outcome reaches responses: `crates/freshell-server/src/session_name_routes.rs:310`, `crates/freshell-server/src/sessions.rs:357`, `crates/freshell-server/src/terminals.rs:1175`, `crates/freshell-freshagent/src/lib.rs:4977, 5604, 6057, 6104`
- Modify: `crates/freshell-freshagent/src/naming.rs:95-100` (`RenameNameInput` gains `cwd: Option<String>`; every struct literal, including the existing tests under `crates/freshell-ws/tests/` and `crates/freshell-server/src/session_names_tests.rs`, adds it). Each rename caller above fills it with the best-known folder for its target (LB-B8): the pane, tab and terminal routes from the terminal row (`TerminalRegistry::directory()` entries carry `cwd`, `crates/freshell-terminal/src/registry.rs:4564`; a fresh-agent pane from its session's cwd), the session-key routes from the session index row; `automation_rename_decision` classifies with it
- Modify: `crates/freshell-freshagent/src/naming.rs:616-640` (`observe_native_live`: build the observation once, one inline attempt, then hand-off to the retrier; never sleeps inline)
- Modify: `tools/freshell-cli/index.ts` `rename-tab` (:531) / `rename-pane` (:641): print `name not applied: <reason>` to stderr when the outcome at the route's nesting (G40: `res.data.sessionName.outcome` for the freshagent routes) has `applied === false`; `tools/freshell-mcp/freshell-tool.ts` rename actions include the outcome in the tool result text
- Fixtures: extend `test/e2e-browser/fixtures/providers/fake-opencode-server.mjs` and `test/e2e-browser/fixtures/fake-opencode-terminal.mjs` with env `FAKE_OPENCODE_TITLE_SEQUENCE` (pipe-separated titles emitted as `session.updated` SSE events, ~300 ms apart, on the event stream each lane already attaches to — mirror the contract in `crates/freshell-ws/src/opencode_lane.rs` and `crates/freshell-freshagent/src/opencode_ws.rs`)
- Create: `test/e2e-browser/helpers/session-names-fixture.ts` (writes a valid version-1 name document with the given records into an owned server's HOME before boot — no e2e seeds this file today; take the required fields from `StoredDocument` and the store's own test builders; Task 11 extends it for its synthetic large document). Transcripts are seeded with the existing `writeClaudeSession` (`test/e2e-browser/helpers/session-corpus/claude.ts:56`)
- E2e: create `test/e2e-browser/specs/name-self-heal-rust.spec.ts`

- [ ] **Step 1: Write the failing Rust tests** (`session_name_policy_tests.rs`, real store):
  - `opencode_placeholder_observation_is_never_stored`: directory record;
    observe `New session - 2026-10-20T00:09:25.350Z` → unchanged; then
    `Publishing blocked by token error` → `provider_ai` with that name.
  - `first_native_observation_sets_the_baseline_without_replacing`: `provider_ai`
    "Billing bug" with no `last_native_title`; observe "Older provider
    title" → name and revision unchanged, no document write and no publish,
    the staged baseline is "Older provider title" (decisions read it as if
    persisted); one sweep maintenance batch persists it; then observe
    "Newer provider title" → replaced (new revision).
  - `changed_native_title_replaces_older_provider_name`: `provider_ai`
    "Billing bug" with baseline "Billing bug"; observe "Real title" →
    replaced; observe "Real title" again → no new revision.
  - `first_native_observation_heals_a_default_label`: `provider_ai` "Tab 23",
    no baseline; observe "Real title" → replaced (self-heal exception to the
    baseline rule).
  - `native_echo_never_undoes_an_automation_rename`: native "A" accepted;
    automation rename "B" → applied; native "A" again → name stays "B";
    native "C" → "C".
  - `native_observation_never_replaces_protected`: manual, legacy_protected,
    freshell_ai records (including a manual "Tab 23") ignore a changed
    native title.
  - **Pinning test** `stale_location_observation_stays_provenance_only`
    (existing rule kept).
  - `automation_rename_reports_protected`: manual record; automatic rename →
    `outcome.applied == false`, `reason == "protected_name"`, record unchanged.
  - `automation_rename_replaces_equal_rank`: `provider_ai` record → applied,
    new revision, source `provider_ai`.
  - `automation_rename_refuses_default_label`: rename to "Tab 3" →
    `reason == "default_label"`.
  - `automation_rename_to_the_folder_name_is_refused_and_stays_refused`
    (LB-B8): a Claude terminal row with cwd `/home/dan/code/freshell` and a
    `provider_ai` record "Billing bug"; an automatic rename to "freshell"
    through the terminal route → `outcome:{applied:false,
    reason:"default_label"}`, record unchanged; the next sweep pass changes
    nothing (no transaction, still "Billing bug"). Red today: the rename
    applies, and with the self-heal rule the sweep would then replace it.
  - **Pinning test** `automation_rename_to_another_folders_name_applies`
    ("machines" with the target's folder `/home/dan/code/freshell` →
    applied; documents Residual 11).
  - `user_rename_is_never_filtered`: user rename to "Tab 3" → manual "Tab 3".
  - Self-heal (the user-visible cases first):
    - `self_heal_tab_n_provider_ai_takes_the_first_message`: `provider_ai`
      "Tab 23"; `AcceptedUserMessage` activity "Fix the sardine importer" →
      `first_message` "Fix the sardine importer" (today: refused, because
      `provider_ai` outranks `first_message`).
    - `self_heal_never_touches_a_manual_tab_n`: manual "Tab 23" (and the
      same for `legacy_protected` and `freshell_ai`): the same activity, a
      native "Real title" and a hydrate input with a provider title → all
      unchanged, no new revision; `activity_pending` and
      `hydrate_indexed_pending` both report no work.
    - `self_heal_uses_the_known_folder`: `provider_ai` "freshell" + activity
      with `cwd: Some("/home/dan/code/freshell")` and a first message →
      replaced; the same record + activity with `cwd: None` → unchanged
      (folder-free patterns only; pins the limit).
    - `hydrate_reoffers_to_a_self_heal_record`: OpenCode session record
      `provider_ai` "OpenCode agent"; `hydrate_indexed_pending` → true;
      hydrate with provider title "Publishing blocked by token error" →
      replaced at `provider_ai`, no series created; `hydrate_indexed_pending`
      → false afterwards.
    - `planned_fallback_is_applied_without_the_strict_raise` (C1): a
      `first_message` record named "Claude CLI" (a default label at the
      same rank as the offer) + `AcceptedUserMessage` "Fix the sardine
      importer" → healed; the same activity again → `activity_pending`
      false and no transaction. Red today: `offer_mut` refuses equal rank.
    - `hydrate_default_rung_steps_down_once` (C2): `provider_ai` "Tab 23", hydrate
      input with cwd `/w/work`, no title, no message → `directory` "work";
      a second hydrate → Read with no new revision and the pre-check false;
      a hydrate with `cwd: None` (its rung would be the provider label) →
      unchanged.
    - `activity_pre_check_reports_pending_for_a_self_heal_record`:
      `activity_pending` true for `provider_ai` "Tab 23" with a first
      message; false after the heal.
    - `stale_view_delays_but_never_loses_a_heal` (C3): process B writes
      "Tab 9" over a settled `provider_ai` record; process A's pre-check,
      on its old view, reports no work; after A's next adopted-view refresh
      the pre-check reports work and the heal applies.
    - `native_echo_never_raises_over_a_healed_name` (C4): native "freshell"
      raises a `directory` record to `provider_ai` "freshell" (baseline
      "freshell"); an activity with `cwd` `/home/dan/code/freshell` heals it
      to `first_message` "Fix the sardine importer"; native "freshell" again
      → provenance only (no raise, no revision); native "Real title" →
      applies.
    - `self_heal_changes_no_arming`: the healing activity arms (or does not
      arm) the series exactly as it would for a real-named record with the
      same source and series state.
  - Batching (LB-B1): `sweep_maintenance_is_batched_and_leaves_room_for_renames`
    — 60 self-heal candidates; each pass makes exactly one maintenance
    commit of at most 25 records, so all 60 are healed after 3 passes with
    ≤ ceil(60/25) = 3 commits in total (store transaction tally); a user
    rename issued while each batch runs succeeds (no `LockUnavailable`);
    a row whose work is an insert or an arm still transacts on its own.
  - Sweep (`crates/freshell-server/src/auto_title_sweep.rs` test module):
    `sweep_heals_a_default_label_and_then_settles`: index rows for two Claude
    sessions with first message "Fix the sardine importer"; records
    `provider_ai` "Tab 23" and manual "Tab 8"; after at most two passes
    (boot, then one later pass) the first record is `first_message` "Fix
    the sardine importer", the manual one is unchanged, and a further pass
    transacts zero times (store transaction tally). This is the proof that
    the pre-checks re-offer to such records (V2 confirmed the design on live
    data under C1–C5).
  - In `native_observation_retry.rs` tests (with the in-crate `RecordingSink`
    extended to inject errors):
    `lock_error_retries_in_background_without_blocking_the_caller` (first
    `observe` → `LockUnavailable`; `observe_native_live` returns in < 20 ms;
    the sink later records the title),
    `an_older_title_never_lands_after_a_newer_one` (title "A" fails, title
    "B" succeeds inline; the background retry of "A" is dropped; final name
    "B") and `a_retry_keeps_the_original_location_stamp` (observation taken
    at location revision 3 fails; the location moves to 4; the retry folds
    with revision 3, so the store treats it as stale).
  - Lane tests: freshopencode `opencode_ws` test feeding placeholder then real
    `session.updated` frames through the lane's existing test harness asserts
    the sink saw only the real title applied and that a following
    non-title frame is relayed while the sink is stalled; CLI lane via the
    `NativeTitleObserver` seam in `main.rs` (exercise through
    `freshell_ws::opencode_lane` tests with a fake event stream).
- [ ] **Step 2: Write the failing e2e.**
  - Extend `test/e2e-browser/specs/unified-agent-names-opencode.spec.ts` and
    `unified-agent-names-freshopencode.spec.ts`:
    `it('shows the provider real title, never the placeholder')` with
    `FAKE_OPENCODE_TITLE_SEQUENCE="New session - 2026-10-20T00:09:25.350Z|Publishing blocked by token error"`;
    assert tab label, pane header and sidebar row equal the real title and
    that no rendered surface ever showed the placeholder (poll the DOM text
    during the sequence).
  - Create `test/e2e-browser/specs/name-automation-outcome-rust.spec.ts`:
    Claude pane, user rename "LotL" in the UI; then
    `freshell rename-tab "Bot name"` via the built CLI
    (`dist/tools/freshell-cli/index.js`, `FRESHELL_URL`/`FRESHELL_TOKEN` of the
    owned server) → stderr contains `name not applied: protected_name`, tab
    still "LotL"; on a fresh pane the same CLI call applies.
  - Create `test/e2e-browser/specs/name-self-heal-rust.spec.ts`:
    `it('a junk saved name heals to the first message and a manual one stays')`:
    `bootUnifiedNamesServer({ mode: 'claude', gemini: <403 fake>, setupHome })`
    where `setupHome` seeds two Claude transcripts (first user messages "Fix
    the sardine importer" and "Plan the offsite") and, through
    `session-names-fixture.ts`, records `provider_ai` "Tab 7" and manual
    "Tab 8" for them; within 15 s `readRecord` shows the first as
    `first_message` "Fix the sardine importer" and the second still manual
    "Tab 8"; opening each session from the sidebar shows those labels on
    its tab and pane header. Red today (hydrate returns early and
    `provider_ai` outranks the fallback).
- [ ] **Step 3: Run red.** `pnpm run test:server session_name_policy`;
  `pnpm run test:server session_name_sweep_batch`;
  `pnpm run test:server auto_title_sweep`;
  `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-freshagent --locked native_observation_retry`;
  `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-freshagent --locked opencode_ws`;
  `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e --project=chromium test/e2e-browser/specs/unified-agent-names-opencode.spec.ts test/e2e-browser/specs/unified-agent-names-freshopencode.spec.ts test/e2e-browser/specs/name-automation-outcome-rust.spec.ts test/e2e-browser/specs/name-self-heal-rust.spec.ts`.
- [ ] **Step 4: Implement** per "Ranking and self-heal" (the table, the
  self-heal rule and the native observation details).
- [ ] **Step 5: Run green** (same commands) plus
  `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-freshagent --locked naming`,
  `pnpm run test:server session_name` (the whole naming suite, which pins
  the existing hydrate and activity behavior for real-named records) and
  `pnpm run test:vitest run test/unit/client/lib/session-names.test.ts test/unit/client/store/sessionNames.test.ts --config config/vitest/vitest.config.ts`
  (the client must accept updates with and without `outcome`).
- [ ] **Step 6: Refactor.** Delete the false comment in `rename_decision`
  ("it can never freeze a name"); keep `offer_mut` for strict-raise callers
  only and route every new rule through the policy module; point Task 3's
  `import_owned_label_loses_bind` at the same classifier call the
  self-heal predicate uses, so "default label" has one server-side meaning.
- [ ] **Step 7: Commit** `fix(names): filter provider placeholders, report automation outcomes and let junk names self-heal`.

### Task 5: First-message fallback on every newly observed first message; wrapper text excluded (D4, RC12)

**Intent:** a terminal-mode Claude/Codex/OpenCode pane gets its first-message
name as soon as the first real message is seen, whether or not AI naming
works; a tool's wrapper text is never taken as the first message; existing
wrapper-text names (172 on the latest live copy, 161 of them with an index
row) heal through the Task 4 self-heal rule once the index offers the real
first message; re-deriving those first messages starts no background AI
naming, and wrapper text is never sent to Gemini.

**Files:**
- Modify: `crates/freshell-sessions/src/text.rs:110-133` — **V5 resolved: the
  shared tag lists (option a).** Add to both `USER_CONTEXT_TAGS` and
  `SYSTEM_CONTEXT_LEAD_TAGS`: `recommended_plugins`, `user_shell_command`,
  `user_action` (Codex's own model-context fragments), and the Claude
  command family `local-command-caveat`, `command-name`, `command-message`,
  `command-args`, `local-command-stdout`, `local-command-stderr`, plus
  `system-reminder`. `bash-input`/`bash-stdout`/`bash-stderr` are NOT added
  (never seen on this host; add them only with evidence). For wrappers at
  the start of a record the existing strip loop already keeps any user text
  that follows the known leading blocks, so option (a) also covers the
  mixed records V5 found. Every consumer of `extract_user_authored_text`
  (titles, search, the AI prompt, first messages, Claude's
  `user_message_count`) sees the change. The Task 1 classifier's leading-tag
  check reads the same list (its TS copy gains the same tags).
- Modify: `crates/freshell-sessions/src/directory_index.rs` — **V2 resolved:
  targeted cache invalidation, no schema bump; once per entry by stamp
  (LB-B11).** `FileEntry` (`:1057`) gains `first_message_rules: u32` with
  `#[serde(default)]` (0 for every existing entry; the struct already uses
  serde defaults, e.g. `source_name`), and a constant
  `FIRST_MESSAGE_RULES_VERSION = 1` is introduced. In `load_cache_file`
  (`:2738-2779`), next to the existing `has_legacy_claude_identity` filter,
  a Claude or Codex entry whose `first_message_rules` is below the current
  version AND whose cached `first_user_message` starts with a context tag
  (`starts_with_context_tag`, Task 1) is dropped, so it is re-parsed once;
  every entry the parser writes is stamped with the current version, and a
  below-version entry that is kept is stamped current too. A stamped entry
  is never content-retested, so even an extraction that still returns a
  tag-led message (an unclosed or attribute-carrying block) cannot cause a
  re-parse on every boot. V2: 164 live entries, about 372 MB re-parsed
  once. Rollback-safe: `CACHE_SCHEMA_VERSION` stays 3 and an older binary
  ignores the new field.
- Modify: `crates/freshell-server/src/session_names.rs` `plan_activity` 2668-2681 (drop the reason filter on `offer_fallback`; the rank check already goes through the Task 4 predicate); `first_message_fallback` 2103-2110 returns `None` for default/derived text (Task 1 classifier).
- Modify: `crates/freshell-server/src/session_names.rs` `plan_activity`'s arming branch (`:2681-2725`) — **V2 resolved: re-absorb at rest (option ii).** On `IndexUserMessage`, an Idle, never-attempted series (`consumed == 0`) whose fingerprint differs from the fed message takes the new fingerprint and excerpt and stays Idle; it arms on explicit open, exactly like the boot snapshot. A session's first user message never changes in reality, only when extraction rules change, so this delays no genuinely new work (V2: without it, the next passes would arm 141 old sessions in the background, up to 423 calls). AI naming for those sessions happens when Dan opens them, as today.
- Modify: `crates/freshell-server/src/session_names.rs` — **prompt-input guard (V2).** A series whose stored excerpt the classifier recognizes as wrapper or derived text is never armed from it: in `plan_activity`, an activity carrying a real first message refreshes the stored input (at rest for `IndexUserMessage` per the rule above; armed for `Opened`/`Resumed`/`AcceptedUserMessage` as today); an activity without one drops the stored input (fingerprint and excerpt cleared, series stays Idle). The bind's explicit-open hook (`:2600-2614`, G50) leaves such a series Idle and drops its input instead of making it Eligible, and the claim (`:3030-3061`) refuses one without consuming, as a last guard. V2: 14 idle series on the live copy store wrapper text and get no new message; today opening one would send that text to Gemini and save the answer as a protected `freshell_ai` name that self-heal could never replace.
- Modify: `crates/freshell-server/src/session_names.rs` (new `needs_first_message_input(target, cwd)`: true when there is no record, the record is below `first_message`, or the record is a self-heal record under that folder — C5) and `crates/freshell-server/src/auto_title_sweep.rs:441-465` (fetch the OpenCode first message when `needs_generation_input || needs_first_message_input(target, row.cwd)`; the "no user message" memo, keyed by session id + index `updated_at`, lives on the sweep's state and persists across passes — C5)
- Modify: `test/fixtures/name-evidence/cases.json` (wrapper-tag rows: `<recommended_plugins>`, `<user_shell_command>`, `<local-command-caveat>Caveat: …`, `<command-name>/model</command-name>`, `<system-reminder>` → default; `Fix <b>bold</b> rendering` → not default)
- Test: `crates/freshell-server/src/session_names_tests.rs`; `crates/freshell-server/src/auto_title_sweep.rs` test module; `crates/freshell-sessions/src/text.rs` tests; `crates/freshell-sessions/src/parse/claude.rs` tests; `crates/freshell-sessions/src/directory_index.rs` tests (next to `load_cache_file_*`, `:6305-6340`)
- E2e: `name-import-shutdown-rust.spec.ts` scenario D; `name-self-heal-rust.spec.ts` (Task 4) gains the wrapper scenario

- [ ] **Step 1: Failing tests.**
  - `opened_activity_offers_first_message_fallback`: directory "work";
    activity reason `Opened` with first message "SMS isn't updating. Root
    cause why." → `first_message` "SMS isn't updating. Root cause why.".
  - `resumed_activity_offers_first_message_fallback` (same with `Resumed`).
  - **Pinning test** `fallback_never_lowers_rank` (real-named `provider_ai`
    record unchanged).
  - `fallback_is_independent_of_generation_exhaustion` (exhausted series,
    directory record, Opened → fallback applied, series stays exhausted).
  - `wrapper_first_message_is_never_a_fallback`: activity whose first message
    is `<recommended_plugins>…</recommended_plugins>` → no offer.
  - `wrapper_first_message_record_heals_to_the_real_first_message`: record
    `first_message` "<recommended_plugins>…"; `IndexUserMessage` activity
    with first message "Fix the sardine importer" → replaced (same rank;
    the self-heal rule applies because the stored name is wrapper text).
  - `text.rs`: one `extract_user_authored_text` test per added tag; the
    real Claude shape as a transcript fixture — an `isMeta` record holding
    only `<local-command-caveat>…`, then `<command-name>/model</command-name>`
    (+ `<command-message>`/`<command-args>`), then
    `<local-command-stdout>…`, then the prompt "Fix the sardine importer" →
    index first user message "Fix the sardine importer"; and the mixed
    record (one record: caveat, `<command-name>/effort…`, stdout, then a
    plain sentence) → the extracted text is the sentence.
  - `parse/claude.rs`, **pinning the accepted change** (G52):
    `command_wrapper_records_no_longer_count_as_user_messages` — a Claude
    transcript whose only records besides one real prompt are caveat,
    command and stdout records now has one counted user message and is
    marked non-interactive (so the sidebar's default filter hides it; V5
    found 1 such session of 32 on this host); and, pinning the other side
    (LB-B7), `two_real_prompts_with_reminders_and_commands_stay_interactive`
    — a Claude transcript with two real prompts interleaved with
    `<system-reminder>`, caveat, command and stdout records counts two user
    messages and is NOT marked non-interactive.
  - `directory_index.rs`: `load_cache_file_reparses_stale_tag_led_entries_once`
    (an unstamped cached Codex entry whose first message starts with
    `<recommended_plugins>` is dropped and re-parsed on the next refresh,
    yielding the real first message and a stamped entry; an unstamped entry
    with a real first message and the same `(mtime, size)` stays cached and
    is stamped; the schema version is unchanged) and
    `stamped_entry_is_never_retested` (a stamped entry whose re-parsed first
    message still starts with a tag — an unclosed `<user_action` block — is
    kept across two further loads with no re-parse).
  - Decision B: `changed_first_message_on_an_idle_series_reabsorbs_without_arming`
    (Idle, consumed 0, old fingerprint; `IndexUserMessage` with a new
    message → fingerprint and excerpt updated, status Idle, no claim
    possible; an `Opened` activity then arms it with the new excerpt).
  - Prompt-input guard: `wrapper_excerpt_is_never_armed` (Idle series whose
    excerpt is `<recommended_plugins>…`: an `Opened` activity with no first
    message drops the stored input and arms nothing; a pending bind to the
    session leaves it Idle; a claim forced on it consumes nothing) and
    `wrapper_excerpt_is_replaced_by_a_real_message` (an `Opened` activity
    carrying "Fix the sardine importer" arms with that excerpt).
  - C5: `opencode_folder_named_record_gets_the_targeted_lookup` (OpenCode
    `provider_ai` record "freshell", row cwd `/home/dan/code/freshell`,
    series exhausted, no first message in the listing → the targeted lookup
    runs and the record heals) and `no_user_message_memo_survives_later_passes`
    (a session with no user message is read once over three passes; a new
    index `updated_at` re-reads it).
  - Sweep: `sweep_names_open_terminal_session_from_first_message` (identity
    registry has a live terminal for the session; index row carries a first
    user message; after one pass the record is `first_message`) and
    `sweep_offers_fallback_for_opencode_with_existing_fingerprint` (OpenCode
    session, directory record, series armed with a fingerprint; the listing
    row has no first message, the targeted lookup has one → after one pass
    the record is `first_message`; a second pass with no message does not
    re-read).
  - E2e D `terminal pane gets the first-message name with AI naming failing`:
    `bootUnifiedNamesServer({ mode, gemini: <403 fake> })` for `claude`,
    `codex` and `opencode` (parametrized), `sendFirstMessage("Fix the sardine importer")`
    → tab label and record become "Fix the sardine importer" (first_message),
    not the folder name, within 10 s.
  - E2e (in `name-self-heal-rust.spec.ts`)
    `it('a wrapper-text saved name heals to the real first message')`: a
    seeded Claude transcript in the real shape above (caveat → command →
    stdout → "Fix the sardine importer"), with a seeded record
    `first_message` "<local-command-caveat>Caveat: …" → within 15 s the
    record and the opened tab read "Fix the sardine importer", and the fake
    Gemini received no request (no background arming).
- [ ] **Step 2: Run red.** `pnpm run test:server plan_activity`;
  `pnpm run test:server auto_title_sweep`;
  `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-sessions --locked extract_user_authored_text`;
  `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-sessions --locked load_cache_file`;
  `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-sessions --locked stamped_entry_is_never_retested`;
  `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-sessions --locked command_wrapper_records`;
  `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-sessions --locked stay_interactive`;
  e2e `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e --project=chromium test/e2e-browser/specs/name-import-shutdown-rust.spec.ts test/e2e-browser/specs/name-self-heal-rust.spec.ts`.
- [ ] **Step 3: Implement** (remove the `matches!(reason, …)` guard around
  the fallback block; keep validation and the Task 4 rank predicate; the
  tag lists, the cache filter, re-absorb at rest, the prompt-input guard
  and the sweep-fetch change above).
- [ ] **Step 4: Green** (same commands) plus the Task 1 fixture tests,
  `pnpm run test:server session_name` and the whole
  `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-sessions --locked`
  (title, search and non-interactive consumers of the extraction).
- [ ] **Step 5: Refactor.** Update `plan_activity`'s doc comment, the
  `needs_generation_input` comment ("bounds the targeted first-message
  lookups") and the `activity_pending` pre-check comment; confirm the sweep's
  per-pass settled memo still proves no-ops (existing sweep tests, including
  `settled_scoped_sessions_transact_zero_on_later_sweep_passes`).
- [ ] **Step 6: Commit** `fix(names): apply the first-message fallback for open sessions and skip tool wrapper text`.

### Task 6: Generation routing, capability classification and pause (D5 as amended)

**Intent:** a configured Gemini key (Dan has one in Settings) always wins and
is sent with every request, directly to Google when the ambient proxy is
OneCLI's and through the ambient proxy otherwise (LB-B5/B6); only with no
key does naming borrow the inherited OneCLI identity; credential, permission, proxy and quota failures pause naming without
using up a session's attempts or losing the naming input; failures are logged
once with their code; naming recovers by itself when the credential starts
working.

**Files:**
- Create: `crates/freshell-server/src/gemini_failure.rs` (`GeminiFailure { class, status, provider_code }`, `classify_gemini_failure(status, body) -> GeminiFailure`, `classify_transport_error(chain: &(dyn std::error::Error + 'static), is_connect: bool, is_timeout: bool, via_proxy: bool) -> GeminiFailure` with a thin adapter from `reqwest::Error`, so tests can feed a synthetic source chain, `impl Display` producing the old `gemini http <status>` text plus ` (<code>)`)
- Create: `crates/freshell-server/src/session_name_capability.rs` (`CapabilityLatch` with the Capability window and the Throttled backoff, `NamingRoute` + `select_naming_route(key_cell, proxy_env)`, `via_proxy(proxy_env, url)` over the existing `GeminiProxyEnvironment`, `SessionNameTransport` trait returning `Result<String, GeminiFailure>`)
- Modify: `crates/freshell-server/src/ai_title.rs:256-288, 325-391, 437-450` (`GeminiSessionNameHttp` implements `SessionNameTransport` over the selected route: keyed requests on a `.no_proxy()` client when the ambient proxy is OneCLI-marked, otherwise on the normal proxy-honoring client (`reqwest::Client::new()` semantics); no-key requests on the normal client; remove the OneCLI→key retry; the shared `GeminiTransport` users stay unchanged)
- Modify: `crates/freshell-server/src/session_name_generation.rs` (`transport: Arc<dyn SessionNameTransport>`; `capability_ready` consults the route and the latch; map failure classes to new `GenerationOutcome::CapabilityUnavailable{code}` / `Throttled`)
- Modify (wiring): `crates/freshell-server/src/session_names.rs` claim 3030-3061 (no exhaustion, no excerpt clear) and fold 3063-3152 (refund path; exhaustion at the cap for `Empty`/`Failed`); `crates/freshell-server/src/main.rs:953-1000` (route-selected INFO log, inherited-identity WARN, construct latch)
- Modify: `crates/freshell-server/Cargo.toml` (direct `rustls` dependency at the lockfile's 0.23.41, for the certificate-error downcast; no new crate in `Cargo.lock`)
- Modify: `crates/freshell-runtime-observability/src/lib.rs` (`AQ.` key form in the common-secret regex at `:61-69`; the writer's scrub also replaces every value in a shared live-secret set, beside the exact `AUTH_TOKEN` it already replaces at `:92-96`), `crates/freshell-server/src/logging.rs` (`LoggingConfig` carries the shared set), `crates/freshell-server/src/main.rs` (puts the key cell's value in it after `AiKeyCell::init`) and the Settings PATCH path (refreshes it after `apply_settings_key_forced`, `settings_store.rs:2139-2143`) — LB-B13; tests next to the `scrub_*` tests in `crates/freshell-server/src/logging.rs:495-535`
- Modify: `crates/freshell-server/src/settings_store.rs:2140-2146` (a saved key calls the generator's `notify_capability_change`, which also clears both latches and re-selects the route; today the PATCH path never wakes the worker)
- Tests: `crates/freshell-server/src/session_name_generation_tests.rs` (update fakes to the new trait), `crates/freshell-server/src/session_name_native_tests.rs:1110, 1988` (fakes), new cases below. Rewrite the tests that pin the removed precedence (G43): `ai_title.rs` `session_name_onecli_route_omits_direct_key` and the `onecli_missing_*` retry tests (`:1034-1200`), and `onecli_missing_credential_worker_fallback_saves_ai_name` (`session_name_generation_tests.rs:718`)
- E2e: create `test/e2e-browser/specs/name-generation-capability-rust.spec.ts`; give `startFakeOneCliGeminiProxy` (`test/e2e-browser/helpers/unified-agent-names.ts:122-170`) the real gateway's no-key behavior (G49): 403 `{error:"access_restricted",message,manage_url,provider}` in mode `access_restricted`, answered as the gateway's own credential would be in mode `ok` (a mutable `mode: 'ok' | 'access_restricted'`); it records every request, keyed or not, so a test can assert that keyed requests never traverse it; extend `startFakeGemini` with a `validKey` option (any other key → 400 `API_KEY_INVALID`); change `bootJourney`'s OneCLI env (`test/e2e-browser/helpers/unified-agent-names-modes.ts:75-83`) to set `GOOGLE_GENERATIVE_AI_API_KEY: ''` unless a journey opts into a key, so the existing OneCLI journey (`:251-287`, `hasApiKey:false`) keeps testing the no-key proxy route

- [ ] **Step 1: Failing tests.**
  - `classify_onecli_access_restricted_as_capability` (403 + the exact body
    from `gemini-probe.json` minus the URL) → class Capability, code
    `access_restricted`; `classify_onecli_400_access_restricted_as_capability`
    (the gateway's bad-key answer: 400 + OneCLI body → Capability, NOT
    `Invalid`); `classify_google_permission_denied_as_capability`;
    `classify_api_key_invalid_as_capability` (400 Google body); `classify_429_as_throttled`;
    `classify_500_as_transient`; `classify_proxy_connect_refusal_as_capability`
    (a fake proxy that answers the CONNECT with 407, and one that is not
    listening → `proxy_unreachable`); `classify_untrusted_certificate_by_downcast`
    (a synthetic chain wrapper → `std::io::Error` → `rustls::Error::InvalidCertificate(UnknownIssuer)`
    → `proxy_tls` with `via_proxy`, `tls_untrusted` without; a chain whose
    text says "invalid peer certificate" but holds no rustls error → not
    a certificate class); `classify_direct_connect_failure_as_capability`
    (`direct_unreachable`); `classify_timeout_as_transient`.
  - Route selection: `configured_key_goes_direct_when_the_ambient_proxy_is_onecli`
    (key set AND an ambient OneCLI-marked fake proxy: exactly one request,
    carrying `x-goog-api-key`, reaches the loopback fake Gemini directly;
    the fake proxy records zero requests), `configured_key_uses_an_ordinary_ambient_proxy`
    (key set AND an unmarked fake proxy: the keyed request goes through
    that proxy), `classify_429_before_the_onecli_body_rule` (429 with a
    OneCLI-style body → `Throttled`, not `Capability`; LB-B10),
    `boot_log_reports_key_route_transport`,
    `settings_key_is_used_when_no_env_key` (key only in `settings.ai.geminiApiKey`),
    `no_key_uses_the_inherited_onecli_proxy_without_a_key` (today's
    behavior, `hasApiKey:false`), `inherited_proxy_route_logs_one_warning`,
    `no_credential_means_no_claims`.
  - `capability_failure_refunds_the_attempt`: arm a series, claim, fold
    `CapabilityUnavailable` → `consumed == 0`, status Eligible, not exhausted,
    excerpt unchanged.
  - `third_attempt_capability_failure_keeps_the_series_and_its_excerpt`:
    consumed 2, claim (consumed 3, InFlight, excerpt still present), fold
    capability → consumed 2, status Eligible, excerpt equals the armed
    excerpt; the next claim sends that excerpt.
  - `third_attempt_real_failure_exhausts_in_the_fold`: same setup, fold
    `Failed` → Exhausted, excerpt cleared.
  - **Pinning test** `interrupted_start_at_the_cap_still_exhausts_at_recovery`.
  - `latched_capability_pauses_without_claims`: after one capability failure
    the worker makes no further claims until the re-probe time
    (`FRESHELL_NAMING_CAPABILITY_REPROBE_MS=50`), then exactly one probe.
  - `throttled_latches_with_growing_backoff`: with
    `FRESHELL_NAMING_THROTTLE_REPROBE_MS=20` and a fake that always answers
    429, probes happen at ~20, ~40, ~80 ms gaps (never back-to-back), the
    series' `consumed` never moves, and one success resets the base.
  - `capability_logs_once_per_transition` (capture `tracing` output with the
    crate's existing log-capture helper; three failures → one WARN with
    `code=access_restricted`, no secret, no URL).
  - `scrub_redacts_aq_form_gemini_keys` (a synthetic `AQ.` key of Dan's
    key's length inside a log line, a JSON field and an error string →
    redacted; the existing `AIza…` and non-secret cases unchanged) and
    `scrub_redacts_the_configured_key_value` (a key value that matches no
    pattern, e.g. one containing a second `.`, put in the live-secret set →
    every occurrence redacted; after a Settings save of a new key, the new
    value is redacted too).
  - `saved_key_clears_the_latch` (latched on the proxy route; settings PATCH
    with `ai.geminiApiKey` → the next poll claims, on the key route).
  - E2e `name-generation-capability-rust.spec.ts`:
    `it('pauses naming on access_restricted and recovers when access is granted')`:
    boot through `bootJourney` with the fake OneCLI proxy (mode
    `access_restricted`) and NO key, `FRESHELL_NAMING_CAPABILITY_REPROBE_MS=2000`,
    Claude terminal pane, first message → name is the first-message
    fallback; the server log (`capturedOutput().stdout`) has exactly one
    `session_names.generation_capability_unavailable` line with
    `access_restricted` and no proxy URL; switch proxy mode to `ok` → within
    10 s the tab shows the AI name and the record source is `freshell_ai`.
    `it('a key entered in Settings takes over from a refusing proxy')`: a
    boot where `FRESHELL_GEMINI_BASE_URL` is a loopback fake Gemini (with
    `validKey`) and `HTTP_PROXY` is the fake OneCLI proxy in mode
    `access_restricted` (with `NO_PROXY` empty, the no-key request still
    traverses the fake proxy: reqwest's proxy matcher has no implicit
    loopback bypass, `hyper-util-0.1.20/src/client/proxy/matcher.rs`);
    latched on `access_restricted`; save the valid key through the Settings
    UI; within 10 s the tab shows the AI name; the fake Gemini saw one
    request carrying the key; the fake proxy recorded no keyed request.
    `it('a wrong key pauses naming instead of using up attempts')`: save any
    other key → the fake Gemini answers 400 `API_KEY_INVALID` → one
    `generation_capability_unavailable` WARN with that code, and the
    series' consumed count is unchanged. No request leaves the host.
- [ ] **Step 2: Run red.** `pnpm run test:server gemini_failure`;
  `pnpm run test:server session_name_capability`;
  `pnpm run test:server session_name_generation`;
  `pnpm run test:server session_name_native`; e2e
  `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e --project=chromium test/e2e-browser/specs/name-generation-capability-rust.spec.ts`.
- [ ] **Step 3: Implement** per "Generation capability".
- [ ] **Step 4: Green** (same) plus `pnpm run test:server ai_title` and the
  existing OneCLI journey `test/e2e-browser/specs/unified-agent-names-freshcodex.spec.ts`
  on cloud.
- [ ] **Step 5: Refactor.** Delete `classify_onecli_credential_error` and the
  OneCLI→key retry once the new classifier and route rule cover them; keep
  `safe_session_name_request_error`'s no-secret guarantee and add a test that
  a reqwest proxy error string (which can contain the proxy URL) never
  reaches logs.
- [ ] **Step 6: Commit** `fix(names): use the configured Gemini key first and pause on credential or quota failures without consuming attempts`.

### Task 7: Saved-name tab title mirror (D2)

**Intent:** a Claude/Codex/OpenCode tab's stored title follows its saved name
whenever the saved name is known (so reloads, the server mirror and the tabs
registry show the right name even before names load), never falls back to a
provider label, and no legacy writer touches it.

**Files:**
- Create: `src/store/savedNameTabTitleMirror.ts` (middleware: after each action, diff `selectSessionTabSavedNames` against `tab.title`; dispatch `mirrorSessionTabTitles` for differences only)
- Create: `src/lib/tab-title-ownership.ts` (`canWriteLegacyTabTitle(state, tabId)`)
- Modify: `src/store/selectors/sessionNameSelectors.ts` (new `selectSessionTabSavedNames`: records only, never a fallback); `src/store/selectors/tabsRegistrySelectors.ts:163-186` (overlay uses it)
- Modify (wiring): `src/store/tabsSlice.ts` (new reducer `mirrorSessionTabTitles(record<tabId,title>)` that sets `title` only, no `updatedAt`; `updateTab` honors `touchUpdatedAt === false`; gate `:1821`, `:1871`); `src/store/store.ts` (register middleware after `sessionNamesIngestMiddleware`)
- Modify (wiring): `src/components/TerminalView.tsx:3189-3192` (add the gate), `:6136-6143` (gate)
- Modify: `src/store/codingAgentNaming.ts:36-42` (gate)
- Modify: `src/lib/ui-commands.ts:181-196` (`tab.create`: no `titleSetByUser` for scoped pane content); `tab.rename` needs no change (G23) — a unit test pins it
- Modify: `src/lib/session-name-migration.ts:870-887` (comment now true)
- Tests: create `test/unit/client/store/savedNameTabTitleMirror.test.ts`; extend `test/unit/client/store/tabsSlice.test.ts`, `test/unit/client/store/codingAgentNaming.test.ts`, the ui-commands test (find with `grep -rln "tab.create" test/unit/client/lib`); extend the TerminalView OSC test that covers `onTitleChange` (find with `grep -rn onTitleChange test/unit/client/components`)
- E2e: create `test/e2e-browser/specs/session-tab-title-mirror-rust.spec.ts`

- [ ] **Step 1: Failing unit tests.**
  - `it('writes the saved name into a session-owned tab title on session.name.updated')`
    (store with a Claude pane tab `nameSource:{kind:'session',paneId}`, dispatch
    `receiveSessionNames([update "LotL"])` → `tab.title === 'LotL'`,
    `updatedAt` unchanged, `titleSetByUser` undefined).
  - `it('never writes a fallback label when no saved record is cached')`:
    empty name cache, `tab.title === 'LotL'`; dispatch 20 unrelated actions
    (pane focus, layout change, settings update) → title still `LotL`.
    (This is the data-safety test: with the earlier draft's selector the
    title would become the provider label.)
  - `it('the registry overlay never advertises a fallback label')`: empty
    cache → `selectLiveLocalTabRecords` reports the stored `tab.title`, not
    the provider label.
  - `it('follows a rename and a pending→session redirect')`.
  - `it('never writes legacy tabs')` (shell tab title unchanged).
  - `it('an OSC title from a shell pane inside a session-owned tab does not retitle the tab')`.
  - `it('the exit suffix never touches a session-owned tab')`.
  - `it('openSessionTab never retitles an existing session-owned tab')`.
  - `it('tab.create with a caller name on a Claude pane does not freeze the title')`
    (no `titleSetByUser`; when the record arrives the tab follows it).
  - **Pinning test** `it('tab.rename for a session-owned tab is consumed as a scoped rename')`.
  - `it('display falls back to the mirrored saved name when the name cache is empty')`
    (`selectTabDisplayName` with no record and `tab.title === 'LotL'`).
  - E2e `session-tab-title-mirror-rust.spec.ts`:
    `it('a reload with names unavailable still shows the saved name')`:
    Claude pane, UI rename "LotL". The name cache is also filled from
    WebSocket frames (`session.name.updated`, terminal and fresh-agent
    projections, G34), which `page.route` cannot block, so the test isolates
    the mirror in ONE of two ways (the implementer picks and records which):
    (a) a test-only server switch, read once at boot like
    `FRESHELL_GEMINI_BASE_URL` (G47), e.g.
    `FRESHELL_TEST_SESSION_NAMES_UNAVAILABLE=1`, that makes name reads fail
    and strips name records from every projection; the spec restarts its
    owned server with it set (the existing owned-restart pattern), reloads,
    and asserts tab label "LotL" (never "Tab N", folder or "Claude") AND,
    through the test harness, that the Redux `sessionNames` cache holds no
    record for the pane's ref. The switch lands in the red step as test
    infrastructure, so the test is red until the mirror exists (today's
    stored title is the create-time label); or (b) assert the persisted
    layout instead: after the rename, the window's
    `freshell.layout.v3.<windowId>` tab entry has `title === "LotL"` (red
    today, G22), plus the unit test `display falls back to the mirrored
    saved name when the name cache is empty` below for the display half.
    Either way the test must fail on today's code.
    `it('the server layout mirror carries the saved name')`: after rename,
    `GET /api/tabs` (served from the server layout mirror) reports "LotL"
    (red today: the stored title is the create-time label).
- [ ] **Step 2: Red.** `pnpm run test:vitest run test/unit/client/store/savedNameTabTitleMirror.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/codingAgentNaming.test.ts <ui-commands test path> <TerminalView OSC test path> --config config/vitest/vitest.config.ts`;
  `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e --project=chromium test/e2e-browser/specs/session-tab-title-mirror-rust.spec.ts`.
- [ ] **Step 3: Implement** per "Client tab titles".
- [ ] **Step 4: Green** (same) plus `pnpm run test:vitest run test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/store/tabsPersistence.test.ts --config config/vitest/vitest.config.ts`
  and the existing registry spec `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts` on cloud.
- [ ] **Step 5: Refactor.** Replace the inline session-owned check at
  `TerminalView.tsx:6160-6176` with `canWriteLegacyTabTitle` so there is one
  gate.
- [ ] **Step 6: Commit** `fix(names): mirror saved names into session-owned tab titles`.

### Task 8: Managed-runtime merge never writes names (D6)

**Intent:** reconnects and runtime broadcasts stop overwriting tab titles with
"Shell agent"/"OpenCode agent", stop tilting cross-window recency, and only
the tab's naming pane drives tab-level fields; the server stops minting those
labels.

**Files:**
- Modify: `src/lib/recovery/managed-runtime-recovery.ts:291-395` (no `title` in existing-tab updates; tab-level fields only when the matched pane is the tab's naming pane — `nameSource.paneId`, else the first leaf; updates dispatched with `touchUpdatedAt:false`; reconstructed tabs (**V4 resolved**, G51): the tab gets `nameSource:{kind:'session',paneId}` only when `isScopedPaneContent(content)` is true (kilroy resolves a Claude ref but is not scoped, so it stays a legacy tab); it is passed no title, so `addTab` stores `Tab N`, which `getTabDisplayTitle` treats as a default and the derived pane label shows until the Task 7 mirror writes the saved name; a managed OpenCode soul without a native session id has no resolvable ref until `terminal.session.associated` writes its `sessionRef` into the pane (that is when the mirror can fill the title). No inventory or server change. Shell → `view.title` only when non-empty and not default/derived per Task 1, else no title. Existing supervisor rows already carry "Shell agent"/"OpenCode agent" view titles (V3, V4), so this client-side filter, not only the server change below, is what stops them
- Modify: `crates/freshell-server/src/managed_runtime.rs:776` and `crates/freshell-server/src/fresh_agent_proxy.rs:723` (`title: None`)
- Modify: `crates/freshell-supervisor/src/view_intents.rs:103-106, 683-689` (empty fallback instead of "Recovered X agent"); update the unit test at `:971` (it pins the removed fallback)
- Tests: extend `test/unit/lib/managed-runtime-recovery.test.ts`; `crates/freshell-supervisor/src/view_intents.rs` tests
- E2e: create `test/e2e-browser/specs/managed-runtime-title-merge.spec.ts` (cloud-legal); create local-only `test/e2e-browser/specs/managed-runtime-names-local-rust.spec.ts` with its own `describe` and its own rig (registered in `LOCAL_ONLY_SPECS`, `test/e2e-browser/playwright.config.ts:24-36`, classification `local-only-docker-supervisor`). It does NOT extend `runtime-terminal-continuity-rust.spec.ts`, whose serial describe is blocked by the red P2-G01 and whose P2-G04 is paid (G53)

- [ ] **Step 1: Tests.**
  - **Pinning test** `it('a stored "Shell agent" title is visible on a single-pane shell tab')`
    (pure `getTabDisplayTitle` with no pane title → "Shell agent"; settles
    open question 6 and shows why the overwrite matters; passes today).
  - Failing: `it('an existing tab matched to a "Shell agent" view keeps its title and updatedAt')`.
  - Failing: `it('an existing OpenCode tab matched to an "OpenCode agent" view keeps its title')`.
  - Failing: `it('a split tab takes tab-level fields only from its naming pane')`
    (naming pane shell, second pane managed opencode → tab `mode`,
    `codingCliProvider`, `sessionRef` unchanged).
  - Failing: `it('a reconstructed agent tab carries a session nameSource and no provider label')`
    (a scoped OpenCode soul with a native id → `nameSource` set, stored
    title `Tab N`, displayed label the derived pane label, never
    "OpenCode agent").
  - Failing: `it('a reconstructed OpenCode tab without a native id fills its title after the session links')`
    (soul with no `nativeSessionId` → no ref; dispatch the
    `terminal.session.associated` handling for its `terminalId`
    (`reconcileTerminalSessionAssociation`), then `receiveSessionNames`
    with that session's record "Billing bug" → `tab.title === 'Billing bug'`).
  - **Pinning test** `it('a reconstructed kilroy tab stays a legacy tab')`
    (resolves a Claude ref but `isScopedPaneContent` is false → no
    `nameSource`).
  - Failing: `it('a reconstructed shell tab uses a real view title but never a default label')`.
  - Rust: `view_intent_without_title_stays_empty` (supervisor),
    `managed_launch_sends_no_provider_label_title` (server unit around the
    request builder at `managed_runtime.rs:770-779`).
  - E2e `managed-runtime-title-merge.spec.ts` (pattern of
    `managed-recovery-contextual-ui.spec.ts`: `page.route(/\/api\/runtime\/souls/…)`
    serves an inventory whose views are titled "Shell agent"/"OpenCode agent",
    `harness.dispatch(setManagedRuntimeAvailable(true))`,
    `harness.receiveWsMessage({type:'runtime.inventory.changed', …})`):
    `it('a renamed shell tab keeps its name across runtime refreshes')`,
    `it('an unrenamed shell tab never shows "Shell agent"')`,
    `it('an OpenCode tab keeps its saved name after refresh + reload and no import is sent')`.
  - Local-only receipts (Docker supervisor; V3: this lane works on this
    host when a managed case runs alone) in the new
    `managed-runtime-names-local-rust.spec.ts`, each case booting its own
    rig with `FRESHELL_MANAGED_RUNTIME_V1=1` and dropping only the
    WebSocket (`harness.forceDisconnect()`,
    `test/e2e-browser/helpers/test-harness.ts:337`; no server restart, the
    shape that avoids the pre-existing P2-G01 reattach failure). They assert
    STORED state, not the visible label (LB-B3: the visible label survives
    on `main` because the merge skips `titleSetByUser` tabs and a
    session-owned tab displays its cached record):
    `it('an unrenamed managed shell tab keeps its stored title after a dropped WebSocket')`
    — an UNRENAMED single-pane shell tab; after reconnect and the managed
    refresh, the Redux tab's `title` and `updatedAt` are unchanged and the
    persisted layout's tab title is unchanged (never "Shell agent"); and
    `it('a managed OpenCode tab keeps its stored title after a dropped WebSocket')`
    — after reconnect, the Redux tab's `title` is still the mirrored saved
    name and `updatedAt` is unchanged (on `main` the merge writes "OpenCode
    agent" and bumps `updatedAt`); a reload with name reads unavailable
    (the Task 7 isolation) is an acceptable alternative assertion. Both
    also assert that no new terminal was created. **Red receipt required:**
    each case's red run on the unfixed base is recorded; a case that passes
    before the fix is not coverage and must be reshaped until it fails.
    Fallbacks, decided at implementation and recorded in the receipt:
    if the OpenCode case cannot start a managed OpenCode TUI with the three
    OneCLI grant variables unset (the grants are optional,
    `crates/freshell-server/src/managed_provider_bootstrap.rs:396-418`, but
    a grant-free start was never observed; LB-B4), drop that case (the
    unit tests and the shell case cover it); if dropping only the WebSocket
    does not re-attach the same managed terminal (LB-B14), drop the local
    cases and rely on the unit and Rust integration coverage.
- [ ] **Step 2: Red.** `pnpm run test:vitest run test/unit/lib/managed-runtime-recovery.test.ts --config config/vitest/vitest.config.ts`;
  `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-supervisor --locked view_intents`;
  `pnpm run test:server managed_launch_sends_no_provider_label_title`;
  `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e --project=chromium test/e2e-browser/specs/managed-runtime-title-merge.spec.ts`;
  local, one case at a time in the Global Constraints shape:
  `env -u FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE -u FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE -u FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE pnpm run test:e2e:local --project=chromium test/e2e-browser/specs/managed-runtime-names-local-rust.spec.ts --grep 'an unrenamed managed shell tab keeps its stored title after a dropped WebSocket'`,
  then the same with `--grep 'a managed OpenCode tab keeps its stored title after a dropped WebSocket'`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green** (same commands).
- [ ] **Step 5: Refactor.** Extract `tabLevelUpdatesFromNamingPane(...)` as a
  pure helper in the same module and reuse it for creates.
- [ ] **Step 6: Commit** `fix(names): managed-runtime refresh no longer writes tab names`.

### Task 9: New-window rebuild keeps pane titles and user flags (D7)

**Intent:** opening Freshell in a new window (or any inventory rebuild)
restores shell/browser/editor tab and pane names with their "user renamed"
protection.

**Files:**
- Modify: `shared/tab-registry-types.ts:54-59` (`titleSetByUser?: boolean` on `RegistryPaneSnapshotSchema`)
- Modify: `src/lib/tab-registry-snapshot.ts:89-113, 127-157` (pass pane user flags); `src/store/tabRegistrySync.ts:110, 184, 228` and `src/store/selectors/tabsRegistrySelectors.ts:149-179` (supply `paneTitleSetByUser`)
- Modify: `crates/freshell-server/src/recovery_inventory.rs:1010-1033` (forward pane `title`, pane `titleSetByUser`, tab `titleSetByUser`; NOT part of the dismissal digest at `:991-1009`); if `crates/freshell-ws/src/tabs.rs` record normalization (`:1013`, `:1143`) drops unknown pane keys, allow the new one
- Modify: the client inventory type consumed by `buildRecoveryPlan` (find with `grep -rn "tabName" shared/*.ts src/lib/api.ts`), `src/lib/recovery/build-recovery-plan.ts:139-160, 400-437` (`paneTitles` and `paneTitleSetByUser` remapped through `paneIdMap`; tab `titleSetByUser` only for non-session-owned tabs; scoped panes' titles dropped via `stripScopedPaneTitleMetadata`)
- Modify: `src/lib/machine-workspace.ts:197-213` and the recovery-offer consumer (`grep -rn "buildRecoveryPlan" src/components`) to pass `titleSetByUser`/`paneTitleSetByUser`
- Tests: `test/unit/client/lib/tab-registry-snapshot.test.ts`, `test/unit/client/lib/recovery/build-recovery-plan.test.ts`, `test/unit/client/lib/machine-workspace.test.ts`, `crates/freshell-server/src/recovery_inventory_tests.rs`
- E2e: create `test/e2e-browser/specs/new-window-name-restore-rust.spec.ts`

- [ ] **Step 1: Failing tests.**
  - `it('registry pane snapshots carry the pane user flag')`.
  - Rust `inventory_forwards_pane_titles_and_user_flags`; **pinning test**
    `inventory_digest_ignores_titles` (renaming a pane does not change the
    dismissal id).
  - `it('buildRecoveryPlan restores pane titles and flags through the pane-id remap')`.
  - `it('buildRecoveryPlan never restores titles for scoped agent panes')`.
  - `it('restoreMachineWorkspace keeps titleSetByUser on legacy tabs')`.
  - E2e `new-window-name-restore-rust.spec.ts`:
    `it('a renamed shell tab and pane keep their names in a new window')`
    (rename via UI inline editors to "MyShellTab"/"KeepMePane"; `context.newPage()`;
    labels present; Redux `titleSetByUser` and `paneTitleSetByUser` true);
    `it('the restored names stay protected from OSC titles')` (in the new
    window type `printf '\033]0;intruder\007'` in the shell; labels unchanged);
    `it('a browser pane title survives a new browser context')`
    (`browser.newContext()` with the same machine id seeded).
- [ ] **Step 2: Red.** `pnpm run test:vitest run test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/lib/recovery/build-recovery-plan.test.ts test/unit/client/lib/machine-workspace.test.ts --config config/vitest/vitest.config.ts`;
  `pnpm run test:server recovery_inventory`;
  `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e --project=chromium test/e2e-browser/specs/new-window-name-restore-rust.spec.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green**, plus `local-first-reload-rust.spec.ts` and
  `pane-title-folds-rust.spec.ts` (neighbors of this path) on cloud.
- [ ] **Step 5: Refactor.** One `remapPaneKeyedMap(map, paneIdMap)` helper for
  titles and flags.
- [ ] **Step 6: Commit** `fix(names): new-window rebuild restores pane titles and rename flags`.

### Task 10: Bind naming from durable identity on every terminal row path (D8)

**Intent:** every terminal row the server creates or adopts — WebSocket
create, REST create, resume, auto-resume, managed register/reattach, compat
adoption — carries its session name; a transient store error is retried
instead of leaving the row nameless or unbound; a conversation switch (for
example Claude's `/clear`) moves the row to the new session and shows that
session's name, as the existing contract says (G45).

**Files:**
- Create: `crates/freshell-freshagent/src/terminal_name_binding.rs` (+ `terminal_name_binding_tests.rs`), per "Terminal naming bind"
- Create: `crates/freshell-ws/src/terminal_naming.rs` (`TerminalNameBinder` impl over the identity registry; thin `bind_ws_terminal_naming(state, …)` wrapper)
- Modify (wiring, production callers only — G25): `crates/freshell-ws/src/terminal.rs` — `admit_create_naming` (4751-4870: separate "read failed" and "no record"; durable branch and `ensure_pending` use the helper), WS managed create `register_managed` at `:6876`, compat adopt `:3459`, reconcile adopt `:8481`, `respawn_agent_terminal` (`:7680`; after `set_meta` at 8099-8107), compat adoption (5676-5735); `crates/freshell-freshagent/src/terminal_tabs.rs` — REST managed create `register_managed` at `:2906` and REST CLI naming admission `:3457-3545` (both through the helper, with the REST door's `TerminalNameBinder`)
- Modify: the async call sites of the identity upsert's retarget (`crates/freshell-ws/src/identity.rs:314-330` is synchronous; its signal-rebind callers already await) call the helper right after the upsert, so the registry binding moves with the identity ref; every other retarget is caught by the tick's "identity ref ≠ registry ref" reconcile within one tick. The helper logs INFO `session_names.terminal_binding_moved {terminal_id, from, to, has_record}` (refs only)
- Modify: `crates/freshell-terminal/src/registry.rs:4752` (`register_managed` title from the descriptor mode via a passed-in label; the helper then overwrites with the saved name)
- Modify (wiring): `crates/freshell-server/src/main.rs:1352-1398` (tick reconciles: identity ref ≠ registry ref, re-binding the row to the identity's ref and filling its cache from that session's record or the fallback; bound rows with an empty cache; scoped-mode rows with no ref)
- Fixture: extend `test/e2e-browser/fixtures/providers/fake-claude.mjs` with a conversation-switch arm (e.g. on the input line `/clear` it starts a new session id and writes the new transcript) that produces whatever signal reaches the identity upsert with a new session id. Which signal that is (the session-start signal path feeding `identity.rs:300-330`, a new transcript seen by the watcher, or another) is an implementation detail: the implementer locates the producer, mirrors it, and records it in the receipt. The unit tests drive the upsert directly and do not depend on it
- Decision rule for the hosted fresh-agent proxy (`crates/freshell-server/src/fresh_agent_proxy.rs`, flag `FRESHELL_MANAGED_FRESH_AGENT_V1`): if wiring the helper plus `report_accepted_input` into its create/send path is ≤ ~60 changed lines with an existing test seam, do it here with a test `hosted_fresh_agent_create_binds_naming`; otherwise record it in Residuals and add a boot-time WARN when the flag is on.
- E2e: extend `test/e2e-browser/specs/agent-crash-autoresume-rust.spec.ts` and `test/e2e-browser/specs/unified-agent-names-claude.spec.ts`
- Rust integration test (V3: server-restart naming for a managed soul is proven here, not in a browser spec): create `crates/freshell-ws/tests/managed_restart_naming.rs` on the in-process WebSocket harness of `crates/freshell-ws/tests/pane_reconcile.rs` and the shared `NamingProbeSink` (`tests/common/mod.rs:385`, extended to serve a seeded record), with a fake `ManagedTerminalController` (lookup plus launch) installed through `TerminalRegistry::set_managed_controller` (the in-crate `LookupOnlyController` at `crates/freshell-ws/src/terminal.rs:3635-3660` is the pattern) standing in for the supervisor after a restart (G54). It covers EVERY adopt/create entry a restarted server might use (LB-B2), because which one production takes after a real managed restart is not known: today that path is broken by the out-of-scope P2-G01 reattach bug (Residuals), so the binding helper is proven at all of them and whichever path production uses once that bug is fixed is already covered

- [ ] **Step 1: Failing tests** (`terminal_name_binding_tests.rs` with the
  in-crate `RecordingSink`, extended to inject errors, and a fake
  `TerminalNameBinder`):
  - `resume_create_retries_a_lock_error_and_fills_the_cache` (first `get` →
    `LockUnavailable`, second → record "LotL"; row `session_name_of` is "LotL",
    binding durable).
  - `resume_create_read_failure_never_falls_into_the_fresh_pending_path`
    (all gets fail, a persisted `namingHandle` present → binding is the
    durable ref, outcome `Deferred`; no `ensure_pending` call; a later tick
    fills the cache).
  - `ensure_pending_failure_keeps_a_pending_binding_for_the_tick` (all
    `ensure_pending` calls fail → the row is bound to the pending ref; the
    tick's next pass creates the record).
  - `tick_binds_a_scoped_row_with_no_ref`.
  - `tick_reconciles_bound_rows_with_empty_cache`.
  - `register_managed_opencode_soul_binds_saved_name_and_mode_title` (row
    title is the saved name; with no record, "OpenCode", never "Shell").
  - `rest_managed_create_binds_naming` (through the REST door's binder; in
    `crates/freshell-freshagent` tests around `terminal_tabs.rs:2906`).
  - `adopt_managed_for_reconcile_binds_naming`.
  - `compat_adoption_binds_naming`.
  - `respawned_agent_row_carries_binding_and_saved_name`.
  - `conversation_switch_adopts_the_new_sessions_record`: terminal bound to
    A ("LotL"); B has a record "Billing bug"; drive `identity.upsert` with
    session B → registry `name_ref_of` is B and the row's cached name is
    "Billing bug" (through the helper, and through the tick when the helper
    is skipped); A's record still "LotL". Red today: the registry stays on A.
  - `conversation_switch_to_a_session_without_a_record_shows_the_fallback`:
    same, B has no record → registry ref is B (not the pending handle, which
    redirects to A), no record is created, the row title is the mode label;
    after B's hydrate or first-message activity the row shows B's name.
  - E2e: `agent-crash-autoresume-rust.spec.ts` new case
    `it('the auto-resumed terminal keeps its saved name')` (rename "Survivor",
    crash the fake CLI, after auto-resume `GET /api/terminals` row `sessionName.name === 'Survivor'`
    and the Overview card shows it); `unified-agent-names-claude.spec.ts` new
    case `it('a conversation switch shows the new conversation name')`
    (rename "LotL"; trigger the fake's switch arm; `/api/terminals` row's
    `nameRef` is the new session and the pane label is no longer "LotL" (the
    new session's fallback); send a first message → the label becomes that
    message; the old session's record is still "LotL").
  - Rust integration (`managed_restart_naming.rs`), one case per entry, each
    on a fresh server state (the "restarted" process) whose registry has no
    row and whose naming sink holds the soul's session record "Survivor";
    each asserts the resulting row is bound to the session ref, caches
    "Survivor" and is never titled "Shell":
    `restart_reconcile_adopt_binds_the_saved_name` (a negotiated
    `pane.reconcile.request` for the soul's terminal id →
    `adopt_managed_for_reconcile`, `terminal.rs:8481`);
    `restart_compat_adopt_binds_the_saved_name` (a non-negotiated
    `terminal.create` carrying the soul's create request id →
    `adopt_existing_managed_for_compat`, `terminal.rs:3443-3466`);
    `restart_resume_create_binds_the_saved_name` (a `terminal.create`
    resuming the soul's session id → the durable branch of
    `admit_create_naming`, `terminal.rs:4751-4870`);
    `restart_managed_create_binds_the_saved_name` (a negotiated managed
    create through the fake controller's launch → `register_managed`,
    `terminal.rs:6876`). Red today (G25/G26: those paths never bind or
    title "Shell"). The browser-level server restart of a managed soul is
    not used: it hits the pre-existing reattach failure (P2-G01).
- [ ] **Step 2: Red.** `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-freshagent --locked terminal_name_binding`;
  `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-ws --locked terminal_naming`;
  `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-terminal --locked register_managed`;
  `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-ws --locked --test managed_restart_naming`;
  `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e --project=chromium test/e2e-browser/specs/agent-crash-autoresume-rust.spec.ts test/e2e-browser/specs/unified-agent-names-claude.spec.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green** (same) plus `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-ws --locked identity`.
- [ ] **Step 5: Refactor.** Fold the duplicated "set identity binding + set
  registry naming + update cache" sequences in `admit_create_naming`,
  `terminal_tabs.rs:3491-3545` and `bind_pending_naming`
  (`identity.rs:640-646`) into the helper.
- [ ] **Step 6: Commit** `fix(names): bind saved names on every terminal create and adoption path`.

### Task 11: Lock-free name reads and a cheap cross-process peek (D9)

**Intent:** reading names never waits on the file lock or re-parses the
document, and the 2 s tick is nearly free when nothing changed. Nothing is
pruned or compacted: `migration.acknowledged_candidate_ids` and the other
migration bookkeeping stay exactly as they are, because they are the only
idempotency gate an older binary has if it ever runs against this document
again (Dan's charter change; the earlier draft's compaction is withdrawn).

**Files:**
- Create: `crates/freshell-server/src/session_name_store_view.rs` (`DocumentStamp`, `stat_stamp(path)` with `#[cfg(unix)]` file id, `SessionNames::adopt_external_if_changed`, lock-free `get_from_view`)
- Modify (wiring): `crates/freshell-server/src/session_names.rs` (`Adopted` gains the stamp, set in `set_view`/`write_durable`; `get` 1164-1180 → view); `crates/freshell-server/src/session_name_routes.rs:233-248` (drop `refresh_current`); `crates/freshell-server/src/main.rs:1369` (tick uses `adopt_external_if_changed`)
- Keep `refresh_current` for the publisher-lag recovery (`session_names.rs:1323`).
- Tests: `crates/freshell-server/src/session_name_store_view_tests.rs`
- E2e: create `test/e2e-browser/specs/name-read-under-load-rust.spec.ts` (smoke, see Step 1); extend the Task 4 fixture writer `test/e2e-browser/helpers/session-names-fixture.ts` with a synthetic ≥4.5 MB version-1 document (5,000 records, 1,200 idle series with 1.5 KB excerpts, 1,600 acknowledged ids)

- [ ] **Step 1: Failing tests.**
  - `reads_do_not_take_the_document_lock` (the deterministic red test for
    RC9): hold the lock from a second `SessionNames` on the same dir
    (existing `test_hold_once` hook or a raw `File::try_lock` holder); `get`
    returns within 50 ms with the adopted record.
  - `read_sees_cross_process_commit_via_stamp_peek`: process-B store commits a
    rename; process-A `get` (after its peek) returns the new name.
  - `unchanged_stamp_peek_takes_no_lock_and_parses_nothing` (transaction
    tally hook `test_store_transaction_count` stays flat across 100 peeks).
  - `stale_stamp_window_is_bounded_by_the_periodic_full_check` (a test seam
    replaces the document while forcing equal len/mtime; within the 30 s
    window (shortened by the seam) the next peek adopts it).
  - `concurrent_reads_during_write_burst_all_succeed`: 4.5 MB fixture, 30
    concurrent `get`s while 30 renames run → zero errors.
  - Route: `read_route_does_not_call_refresh_current` (tally unchanged by a
    read).
  - E2e smoke `name-read-under-load-rust.spec.ts` (not a red step — whether
    the lock error shows depends on machine speed, so it may pass on cloud
    hardware today): seed the synthetic document, open three pages, reload
    them together while a loop PATCHes 20 renames; assert every
    `POST /api/session-names/read` returned 200 and every tab shows its
    saved name. It guards the end-to-end path after the change.
- [ ] **Step 2: Red.** `pnpm run test:server session_name_store_view` and
  `pnpm run test:server session_name_routes` (two commands; cargo takes one
  filter).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green** + `pnpm run test:server session_name` (whole naming
  suite) + the e2e smoke on cloud.
- [ ] **Step 5: Refactor.** Remove the "never an mtime shortcut" comments
  that no longer hold and document the stamp (Unix: device + inode + length +
  nanosecond mtime, and atomic replace always changes the inode; Windows:
  length + mtime, backed by the 30 s full check).
- [ ] **Step 6: Commit** `perf(names): serve name reads without the document lock`.

### Task 12: Name-change events; codex proxy repair-trigger log spam diagnosed and bounded (D11)

**Intent:** every accepted name change is reconstructable from the log, and
the log stops rotating away within hours — by fixing why the codex proxy
repeats its error where possible, not only by hiding the lines.

**Files:**
- Create: `crates/freshell-server/src/session_name_events.rs` (`NameChangeCause`, `NameChangeEvent { prior, cause }`, `log_name_changes(...)`)
- Modify (wiring): `crates/freshell-server/src/session_names.rs` (`PublishSpec` gains `change: Option<NameChangeEvent>`; each decision fills it; `run_txn_sync` logs after `write_durable` succeeds; `adopt_if_newer` logs `adopted_external`)
- Modify (only per Step 0's finding): `crates/freshell-codex/src/remote_proxy.rs` (`handle_stream_error` generic arm `:1118-1130`), reusing the existing `EmissionGate` (`:826-860`) — no new rate-limit module
- Tests: `crates/freshell-server/src/session_name_events_tests.rs`; `crates/freshell-codex/tests/remote_proxy_relay.rs`

- [ ] **Step 0: Diagnose the spam on current main (1c7e4dff7) before changing
  anything.** The live log (G31) shows a ~1.6/s per-terminal loop of the
  generic "connection errored" trigger. Reproduce it in
  `crates/freshell-codex/tests/remote_proxy_relay.rs` with the existing relay
  harness: a client that reconnects after every close against an upstream
  that errors each connection; count `RepairTrigger` events over 5 s.
  Record in the task receipt: (a) whether #850/#851 already stop the loop
  (e.g. the errors were oversize frames, now classified), (b) if not, why
  the connection keeps erroring (which side errors first, which error kind).
  Outcomes: if the loop is gone, no rate limiter is added and the receipt
  says so; if a real cause remains and its fix is small and inside the codex
  proxy, fix it with its own red test; in every remaining case, gate the
  generic errored trigger per proxy with an `EmissionGate` (same 10 min
  default as the capacity gate) that reports a `suppressed` count on the next
  emitted line.
- [ ] **Step 1: Failing tests.**
  - One test per cause asserting exactly one INFO `session_names.name_changed`
    with correct old/new name, source, revision and cause: `native_observation`,
    `first_message_fallback`, `generation`, `manual_rename`,
    `automation_rename`, `bind_collision`, `hydrate`, `adopted_external`,
    `import` (pre-completion boot path only); plus
    `self_heal_flag_marks_a_healed_default_label` (a `first_message_fallback`
    event over "Tab 23" carries `self_heal: true`; over a real-named
    directory record it carries `false`), `no_event_for_unchanged_or_refused_offers`
    (including a first native observation that only records the baseline),
    `no_event_for_post_completion_imports`, `no_event_for_a_conversation_switch`
    and `no_event_when_commit_fails` (pre-replace failure hook).
  - Per Step 0: `generic_errored_trigger_is_gated_per_proxy` (100 errored
    connections in 1 s → 1 trigger; the next due trigger reports
    `suppressed=99`), or the root-cause test if the loop was fixed instead.
  - E2e: add log assertions to `name-import-shutdown-rust.spec.ts` (one
    `first_message_fallback` event for the first message; zero `import`
    events after reloads), to the opencode placeholder case in
    `unified-agent-names-opencode.spec.ts` (one `native_observation` event)
    and to `name-self-heal-rust.spec.ts` (one `name_changed` event with
    `self_heal: true` for "Tab 7", none for the manual "Tab 8").
- [ ] **Step 2: Red.** `pnpm run test:server session_name_events`;
  `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-codex --locked --test remote_proxy_relay`; e2e the three specs named above.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green.**
- [ ] **Step 5: Refactor.** Remove the per-decision ad-hoc INFO logs that the
  event now supersedes (keep `generation_started`/`failed`, which describe
  attempts, not name changes).
- [ ] **Step 6: Commit** `feat(names): log every accepted name change` (and,
  separately, `fix(codex): bound repeated proxy connection-error triggers`
  if Step 0 produced a codex change).

### Task 13: Contract doc, e2e roll-up, build, code review, gate, PR and merge

**Files:**
- Modify `docs/development/rename-scope-contract.md` with these explicit edits:
  - `:34` ("An automatic offer can only raise rank"): add the equal-rank
    exceptions (a provider's changed native title over an older automatic
    provider-level name, once a baseline title has been observed; an
    automation rename at equal rank), that automation renames return
    `outcome`, and the self-heal rule (a saved name that is a recognizable
    default/derived label gives way to any real automatic name; never for
    `manual`, `legacy_protected` or `freshell_ai`).
  - `:44-48` ("three attempts, then the series stays exhausted"):
    credential, permission, proxy and quota failures pause naming without
    using an attempt; a configured Gemini key is always used first, and the
    inherited OneCLI connection only when no key is configured.
  - `:51-53` ("A multi-session tab stores no name of its own"): now false —
    the tab stores a display copy of its source pane's saved name, written
    only when the saved record is known, and never used as name evidence.
  - `:90-106` ("the only supported path"): it stays the only supported path
    (there is no repair command); add that post-completion browser imports
    are acknowledged without effect, capture runs once per device,
    envelopes are deleted after acknowledgment, the migration bookkeeping is
    never pruned, and recognizable junk names heal through the self-heal
    rule.
  - `:176-191` ("Tab display title"): the mirror rule; `tab.create` with a
    caller name on an agent tab no longer sets the user flag; and the
    difference between `savedNameTabTitleMirror.ts` (session-owned tab
    titles) and `sessionTitleMirror.ts` (session-directory titles into
    non-scoped pane titles) in the pane-title section.
  - New short paragraph: provider placeholders, default/derived labels and
    tool wrapper text are never name evidence; a conversation switch moves
    the pane to the new session and shows that session's name (its fallback
    until it has one).
- `AGENTS.md`: no change (the recovery procedure it summarizes is
  unchanged).
- Modify `README.md`: one plain-language line that AI naming uses the Gemini
  key from Settings, or, with no key, the Freshell server's OneCLI
  connection. `docs/index.html`: no change (no major UI change).

- [ ] **Step 1:** Grep for tests that pinned removed behavior and were not yet
  rewritten: `grep -rn "captureLegacyLayoutEnvelope\|legacy_name_capture_pending\|Recovered OpenCode agent\|evidence_key.cmp\|classify_onecli_credential_error\|onecli_direct_key_fallback" test crates src`.
  Expected: none outside rewritten tests.
- [ ] **Step 2: Full e2e roll-up on cloud** (all specs in the matrix below).
- [ ] **Step 3: Local-only receipts** (Docker supervisor, V3 rules from
  Global Constraints): confirm `chromium_headless_shell-1208` is present
  (else install it into a scratch `PLAYWRIGHT_BROWSERS_PATH`); then run the
  single shell case in `managed-runtime-names-local-rust.spec.ts` as
  `env -u FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE -u FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE -u FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE pnpm run test:e2e:local --project=chromium test/e2e-browser/specs/managed-runtime-names-local-rust.spec.ts --grep '<exact case name>'`
  after a `--list` with the same arguments shows only that case. Never
  while another managed rig runs (including the Step 7 gate, whose
  coordinated suite runs the managed parity files), and never
  `runtime-terminal-continuity-rust.spec.ts`. The Task 10 restart proof is
  the Rust integration test, which runs in Step 7. Under the LB-B4
  fallback, OpenCode merge behavior is covered by unit tests and the cloud
  `managed-runtime-title-merge.spec.ts`: the local OpenCode rig requires
  OneCLI grant files and could spend real model turns.
- [ ] **Step 4: Validation receipts.** Confirm the implementation matches
  each recorded V result: Task 1 leading-tag check only; Task 5 tag set,
  cache filter (no schema bump), re-absorb at rest and the prompt-input
  guard; Task 4/5 conditions C1–C5 each with its test; Task 6 normal
  proxy-honoring client, OneCLI-body-first classification, certificate
  downcast, the direct key route when the proxy is OneCLI's, 429 before
  the OneCLI-body rule, `AQ.` and live-key scrubbing, keyed requests never
  traversing the fake OneCLI proxy; Task 5's per-entry first-message rules
  version; Task 4's batched sweep maintenance and folder-aware automation
  renames; Task 8 scoped-only
  session ownership; the local-only run rules.
- [ ] **Step 5: Build.** `pnpm run build` from the worktree (a linked
  worktree passes the production-port guard).
- [ ] **Step 6: Code review.** An independent reviewer reads the whole
  branch diff against `origin/main` against this plan (specification and
  quality). Fix every accepted finding red → green → refactor, each in its
  own commit; record rejected findings with the reason.
- [ ] **Step 7: Gate.** `pnpm run lint`, `pnpm run typecheck`, cargo fmt and
  clippy (Global Constraints), then
  `FRESHELL_TEST_SUMMARY="name-reliability final gate" GCLOUD_ROBOT_REQUIRE=1 pnpm run check`.
  Pass condition: no failures outside the waived 7-test baseline (list the
  failing tests in the receipt).
- [ ] **Step 8: Recheck when it was gnarly.** For the resumed run, use at most
  10 additional repair/review rounds. Stop immediately at the first passing
  result: no further fixes or review rounds after it passes. If the added
  allowance is exhausted with unresolved findings, stop and report instead
  of landing.
- [ ] **Step 9: Land on main via PR (approved by Dan on 2026-10-22).**
  Commit anything left, push the branch, select the `gh` account per the
  repo rules, open the PR targeting `main` (body ends with the attribution
  line from the session reminder), wait for the required checks (including
  `rust-gate`), merge, fast-forward local `main` from `origin/main`, and
  remove the worktree and branch once clean. Do NOT deploy and do NOT
  restart the live server on port 3001: that needs Dan's "APPROVED".
- [ ] **Step 10: Report to Dan** in plain language: what landed; that the
  deploy needs his "APPROVED" for the server restart; what to expect after
  it: junk names heal over the first sweep passes (about 190 on his data)
  or when a session is next seen; names that are not recognizable junk
  stay, and 11 tool-text names whose sessions are no longer indexed stay;
  old sessions get an AI name when he opens them, not in a background
  burst; AI naming uses his Settings key, sent straight to Google (never
  through the OneCLI gateway), and the first `session_names.generation_*`
  log lines after deploy show whether the key has generation quota (if not,
  naming pauses with a warning and first-message names keep working); one
  Claude session in 32 that
  held only slash commands besides one prompt now counts as
  non-interactive and is hidden by the sidebar's default filter. Also
  report the out-of-scope finding (Residuals): a managed shell is not
  re-adopted after a web-server restart on `main` today (P2-G01).

### Task 14: Heal stored provider-label tab titles; registry opens keep pane names

Added by the coordinator after the Stage 2 reviews (Residual 23 from the
Task 8 review; open concern 3 of the Task 9 receipt). Its specs join the
Task 13 roll-up.

**Intent:** (a) a tab whose stored title is a provider/runtime label an
earlier managed-runtime merge wrote ("Shell agent", "OpenCode agent",
"Recovered <X> agent", or any other provider/mode label, provider
placeholder or wrapper text the shared classifier recognizes for that tab's
mode and provider) stops showing it: such a stored title is not a name.
(b) Opening a tabs-registry record from the Tabs view keeps pane names and
their rename protection, exactly as the Task 9 new-window rebuild does.

**Decisions:**
- **One heal point.** A store middleware,
  `src/store/storedTabTitleHeal.ts` (`storedTabTitleHealMiddleware`), next to
  the Task 7 mirror, plus one pass at store creation so the loaded layout is
  healed before anything reads it. Every way a tab enters the store passes
  it: the persisted-layout load, cross-window sync, the new-window rebuild,
  a registry open, a write from an old client. The heal is a `tabs/` action,
  so the persist middleware writes the healed layout, the layout mirror
  sends the healed title (`GET /api/tabs`), and the tabs registry (built
  from the display title) follows the display: all four agree.
- **The rule.** A stored title heals when all of these hold: the tab has no
  `titleSetByUser`; it has a layout; the title is not already the unnamed
  placeholder (`Tab N`); the tab is legacy-owned (every session-owned tab
  keeps its stored display copy, including before its saved record is
  cached, so the Task 7 mirror and the heal never fight); the title differs
  from the tab's derived label
  (`deriveTabName`; a create-time label equal to it is already no title to
  every display and stays); and
  `isDefaultOrDerivedName(title, { mode, provider })` holds with the tab's
  mode and provider. It heals to `unnamedTabTitle(position)` ("Tab N", the
  placeholder `addTab` and the mirror's reset already store): the title
  only, no `updatedAt` bump, no flag. A session title, a rename and any
  window title the classifier does not recognize are never healed and still
  win. **Changed after the Task 14 review:** the classifier is not given the
  tab's folder, so its folder-name rule never heals a tab title. The tab's
  folder (`tab.initialCwd`, else its naming pane's) need not be the folder
  `deriveTabName` uses (it prefers a coding CLI, fresh agent or browser pane
  over the first shell), so with the folder a shell prompt that titled a
  split tab's window with its own folder name was erased. The old merge
  never stored a folder name, and a folder-name title that differs from the
  derived label is a live title or a create-time label, both of which stay.
  A live window title that is itself a provider label still heals
  (Residual 25).
- **Classifier.** It already recognizes every form the old code wrote
  (`"{Label} agent"` with the server's label or the raw mode string,
  `"Recovered {label} agent"`, and `Recovered`, the rebuild's fallback). The
  shared fixture gains rows pinning those exact forms; both implementations
  read it. No rule change.
- **Registry opens reuse the Task 9 helper.** `restoredTabNames` moves from
  `build-recovery-plan.ts` to `src/lib/restored-tab-names.ts` with the same
  rules (titles remapped through the pane-id map, a flag only with its
  title, scoped agent panes stripped by `stripScopedPaneTitleMetadata`, the
  tab flag only on a tab that is not session-owned).
  `openRecordAsUnlinkedCopy` restores the tab flag, the pane titles and the
  pane flags; `openPaneInNewTab` restores the moved pane's title and flag
  (its tab is new, so it gets no tab flag).
- **Contract doc.** Task 13's `:176-191` ("Tab display title") edit also
  records the heal rule.

**Files:**
- Create: `src/store/storedTabTitleHeal.ts` (middleware + store-creation pass); `src/lib/restored-tab-names.ts` (the Task 9 helper, moved)
- Modify (wiring): `src/store/tabsSlice.ts` (reducer `healStoredTabTitles(record<tabId,title>)`: title only, never a user-renamed tab); `src/store/store.ts` (register the middleware after the mirror; run the creation pass)
- Modify: `src/lib/recovery/build-recovery-plan.ts` (import the moved helper); `src/lib/tab-registry-open.ts` (both opens restore names); `src/lib/recovery/managed-runtime-recovery.ts` and `src/lib/tab-name-source.ts` (refactor: the naming-pane lookup moves to `tab-name-source.ts`; after the Task 14 review the heal reads no folder, so the managed merge is its one user)
- Modify: `test/fixtures/name-evidence/cases.json` (old-merge label rows)
- Tests: create `test/unit/client/store/storedTabTitleHeal.test.ts`; extend `test/unit/client/lib/tab-registry-open.test.ts`; replace the Task 8 pinning test in `test/unit/lib/managed-runtime-recovery.test.ts`
- E2e: create `test/e2e-browser/specs/stored-tab-title-heal-rust.spec.ts` and `test/e2e-browser/specs/tabs-view-name-restore-rust.spec.ts` (cloud-legal: plain shells only); create `test/e2e-browser/helpers/stored-names.ts` (stored-state reads, the persisted-registry wait and the OSC title command, shared with `new-window-name-restore-rust.spec.ts`, which moves onto it)

- [ ] **Step 1: Failing tests.**
  - The Task 8 pinning test `a stored "Shell agent" title is visible on a
    single-pane shell tab` is deliberately reversed: replaced by
    `a stored "Shell agent" title on an unrenamed single-pane shell tab heals to the derived label`
    (stored title `Tab 1`, displayed `Shell`, `updatedAt` unchanged).
  - `storedTabTitleHeal.test.ts`: heals on store creation; heals every
    old-merge label form; never touches a renamed tab; leaves real titles,
    the placeholder and a create-time label equal to the derived label
    alone; heals a tab that arrives later (hydrate, registry open, restore);
    a real OSC title still wins after a heal; a session-owned tab with a
    cached record keeps the mirrored saved name (no fight), one without a
    record heals; the healed title reaches the registry record.
  - `tab-registry-open.test.ts`: a copy restores pane titles and flags
    through the pane-id remap and the tab flag on a legacy tab; a flag
    without its title is not restored; scoped agent panes get no title and a
    session-owned copy no tab flag; a pane opened in a new tab keeps its
    title and flag; a scoped pane opened in a new tab gets none.
  - Fixture rows: `Recovered Shell agent`, `Recovered shell agent`,
    `Recovered OpenCode agent`, `opencode agent`, `claude agent`,
    `Recovered amplifier agent` → default.
  - E2e `stored-tab-title-heal-rust.spec.ts`:
    `it('an unrenamed "Shell agent" tab heals on load and stays healed across reload; a renamed one keeps its name')`
    (a seeded per-window layout; label, Redux title, persisted layout,
    `GET /api/tabs` and the server's persisted registry record, before and
    after a second reload) and
    `it('a healed tab still takes the shell's own window title')`.
  - E2e `tabs-view-name-restore-rust.spec.ts`:
    `it('a renamed pane reopened from the Tabs view keeps its name and rename protection')`
    (closed record, card click) and
    `it('a renamed pane opened in its own tab from the Tabs view keeps its name and rename protection')`
    (card menu); each sends an OSC title into the reopened pane afterwards.
- [ ] **Step 2: Red.** `pnpm run test:vitest run test/unit/client/store/storedTabTitleHeal.test.ts test/unit/client/lib/tab-registry-open.test.ts test/unit/lib/managed-runtime-recovery.test.ts test/unit/shared/name-evidence.test.ts --config config/vitest/vitest.config.ts`;
  `~/.local/bin/mise exec rust@1.96 -- cargo test -p freshell-sessions --locked --test name_evidence`;
  `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e --project=chromium test/e2e-browser/specs/stored-tab-title-heal-rust.spec.ts test/e2e-browser/specs/tabs-view-name-restore-rust.spec.ts`
  from a clean tests-only commit.
- [ ] **Step 3: Implement** per the decisions above.
- [ ] **Step 4: Green** (same commands), plus the neighbors
  `test/unit/client/store/savedNameTabTitleMirror.test.ts`,
  `test/unit/client/lib/recovery/build-recovery-plan.test.ts`,
  `test/unit/client/lib/machine-workspace.test.ts`, and on cloud
  `managed-runtime-title-merge.spec.ts`, `new-window-name-restore-rust.spec.ts`,
  `session-tab-title-mirror-rust.spec.ts`, `sidebar-registry-sync-rust.spec.ts`.
- [ ] **Step 5: Refactor.** One naming-pane lookup (`tab-name-source.ts`)
  for the managed merge (and, until the Task 14 review dropped the folder,
  the heal); the moved helper is the only place the restore rules live.
- [ ] **Step 6: Commit** `fix(names): heal stored provider-label tab titles; registry opens keep pane names`.

## E2e coverage by root cause

All specs use the owned `RustServer` with an isolated HOME and ephemeral port,
fake provider CLIs from `test/e2e-browser/fixtures` wired through
`modeFixture`, and a local fake Gemini or fake OneCLI proxy (the repro track's
approach, already productized in `test/e2e-browser/helpers/unified-agent-names.ts`).

| Root cause | Spec (new or extended) | How it is driven | Lane |
|---|---|---|---|
| RC1 import keeps running | `name-import-shutdown-rust.spec.ts` (new) A–C; `name-import-after-completion-rust.spec.ts` (new, Task 3: forced stale import); `unified-agent-names-cross-mode.spec.ts` (`legacy imports converge in both orders`, rewritten in Task 3) | fake claude CLI, fake Gemini 403, `page.reload()`, `context.newPage()`, seeded per-window keys, request counting; the forced stale import is the old client's `POST /api/session-names/import` sent from the page, with the server's JSONL log read from `logsDir` | cloud |
| RC2 tab title not a mirror | `session-tab-title-mirror-rust.spec.ts` (new) | UI rename; then either the test-only names-unavailable server switch + in-page cache assertion, or the persisted layout title (implementer's pick, Task 7); `GET /api/tabs` | cloud |
| RC3 AI naming never works | `name-generation-capability-rust.spec.ts` (new); `unified-agent-names-freshcodex.spec.ts` (OneCLI journey, now keyless) | inherited OneCLI proxy (no key) = fake OneCLI `access_restricted` → `ok`, re-probe seam, server log; a key saved in Settings takes over | cloud |
| RC4 managed merge titles | `managed-runtime-title-merge.spec.ts` (new); `managed-runtime-names-local-rust.spec.ts` (new, own rig) | routed `/api/runtime/souls` inventory + `harness.receiveWsMessage(runtime.inventory.changed)`; real supervisor, dropped WebSocket (no server restart) | cloud; local-only Docker (exact `--grep`, OneCLI grant env removed, run alone) |
| RC5 placeholder / automation no-op | `unified-agent-names-opencode.spec.ts`, `unified-agent-names-freshopencode.spec.ts` (extended); `name-automation-outcome-rust.spec.ts` (new) | `FAKE_OPENCODE_TITLE_SEQUENCE` in fake opencode terminal/server; built CLI `rename-tab` | cloud |
| RC6 no first-message fallback in terminals | `name-import-shutdown-rust.spec.ts` D (claude/codex/opencode) | fake CLIs, fake Gemini 403, `sendFirstMessage` | cloud |
| RC7 new window drops names | `new-window-name-restore-rust.spec.ts` (new) | UI renames, `context.newPage()`, `browser.newContext()`, OSC `printf` | cloud |
| RC7 Tabs-view opens drop names (Task 14) | `tabs-view-name-restore-rust.spec.ts` (new) | UI pane rename in a split shell tab, close it, reopen from the Tabs view card and open one pane in its own tab from the card menu; OSC `printf` | cloud |
| RC4 old stored provider-label titles (Task 14, Residual 23) | `stored-tab-title-heal-rust.spec.ts` (new) | per-window layout seeded by an init script with an unrenamed and a renamed "Shell agent" tab; label, Redux title, persisted layout, `GET /api/tabs` and the server's persisted registry record across two reloads; OSC `printf` after the heal | cloud |
| RC8 rows without name binding | `agent-crash-autoresume-rust.spec.ts`, `unified-agent-names-claude.spec.ts` (extended, incl. a conversation switch); Rust `crates/freshell-ws/tests/managed_restart_naming.rs` (new) | crashing fake CLI; fake claude switch arm; restarted in-process server reaching a managed soul through every adopt/create entry (reconcile adopt, compat adopt, resume-create, managed create) | cloud; Rust integration |
| RC9 lock contention | Rust `reads_do_not_take_the_document_lock` (red); `name-read-under-load-rust.spec.ts` (smoke) | held lock; synthetic 4.5 MB document, 3 pages reloading + rename burst | Rust; cloud |
| RC10 storage quota blocks saves | `name-storage-quota-rust.spec.ts` (new) | `addInitScript` fills localStorage near quota and seeds 20 stale envelopes/acks; rename a shell tab; reload → name kept; envelope keys gone | cloud |
| RC11 no change history | log assertions in `name-import-shutdown-rust.spec.ts` and `unified-agent-names-opencode.spec.ts` via `RustServer.capturedOutput()` | | cloud |
| RC12 wrapper text as name | Rust `text.rs`, `parse/claude.rs`, `load_cache_file` and `plan_activity` tests; `name-self-heal-rust.spec.ts` wrapper scenario (Task 5) | real-shape Claude transcript fixtures (caveat → command → stdout → prompt; mixed record); seeded transcript + seeded name document | Rust; cloud |
| Existing junk names (self-heal) | `name-self-heal-rust.spec.ts` (new, Task 4) | seeded transcripts + seeded name document ("Tab 7" `provider_ai`, manual "Tab 8"), fake Gemini 403, `readRecord`, open from the sidebar | cloud |

The RC10 spec is written in Task 2 (Step 2, add it alongside scenarios A–C)
and must be red before Task 2's implementation.

## Residuals and out of scope

1. **Per-record name storage** (one file or row per record, a single writer
   queue) — follow-up plan; this plan keeps the single document and removes
   reads from the lock.
2. **Idle generation excerpts (~1.9 MB) and the migration bookkeeping**
   (acknowledged candidate ids, ~0.38 MB) stay: explicit-open arming needs
   the excerpts, and the bookkeeping is an older binary's only idempotency
   gate (Task 11 prunes nothing); shrinking the document belongs with item 1.
3. **Reconstructed managed shell tabs** recover a custom name only if the
   view intent carries a real title; renames do not yet write back to view
   intents (follow-up).
4. **Hosted fresh-agent proxy** naming gap (`FRESHELL_MANAGED_FRESH_AGENT_V1`,
   off in production): fixed in Task 10 only under its size rule; otherwise a
   boot WARN guards it and it is a follow-up before that flag is enabled.
5. **Session-directory degraded-read signal** (rows returned without names
   when a read fails) is not added; Task 11 removes the main cause.
6. **Inherited OneCLI identity** remains only when no Gemini key is
   configured: the server then borrows the launching shell's OneCLI identity
   and logs a boot WARN saying so. With Dan's Settings key the key route is
   used.
7. **Electron `sessionStorage` across relaunches** (open question 7) is not
   measured; Task 9 makes a new window keep names either way.
8. **Codex native sync showing `unsynced`** for one manual name (open
   question 12) is unrelated to reverts and not addressed.
9. **Origin of the ~231k historical document writes** (open question 10) is
   not chased; Task 12's events make any future loop visible.
10. **No in-app UI** for "AI naming unavailable"; it is logged only.
11. **Server-side folder-name check** covers only the folder the server
    knows for the target (index rows, terminal rows, create paths). An
    automation rename to the session's OWN folder name is refused
    (`default_label`); a rename to some other folder's name applies, and
    the self-heal rule cannot recognize such a name either.
12. **Existing names that are not recognizable junk stay** (accepted by
    Dan). The self-heal rule replaces only names the classifier recognizes.
    Imported labels that look typed by a person ("ms-people-summit",
    "DirectorDeck") and folder names from a folder other than the session's
    own ("machines", "podcast") are left as they are; on the live copy
    about 85 import-owned `provider_ai` records are of this kind (G30).
    Nothing lists them for review; Dan can rename any of them. Healing also
    needs the session to be seen: a session no longer in the session index
    (for example a transcript the provider has since deleted) keeps its junk
    name until it is opened or reported again.
13. **Sessions whose AI naming already gave up** (953 exhausted series on
    the live copy) stay exhausted: they keep their first-message or folder
    name (healed if it was junk) and get no AI name unless renamed. Their
    failure reason was never recorded (G17).
14. **About 22 orphan `legacy-pending` records** minted by old imports (G11)
    stay in the document; nothing displays them, and Task 3 stops new ones.
15. **Old client builds left open after the deploy** (low): Task 3 makes
    their imports free; any stale tab-title writes they make stop when the
    window reloads.
16. **11 wrapper-text names with no index row stay** (V2: 9 Codex
    `<user_shell_command>` sessions from automated review probes, 2
    Claude). The sweep never sees them, so self-heal cannot reach them; they
    heal only if the session is opened or reported again.
17. **A name given before the first message is not shown on a reconstructed
    managed tab** until the first message links the session (V4): a managed
    OpenCode soul without a native session id has no resolvable ref until
    `terminal.session.associated`. Until then the tab shows the derived pane
    label. (A possible client-only follow-up: copy `nameRef` from the
    server's terminal row onto a scoped pane that has none.)
18. **Claude's non-interactive flag shifts slightly** (accepted, pinned by a
    Task 5 test): slash-command records (`<command-name>` and its stdout) no
    longer count as user messages, so a Claude session whose only other
    content is one prompt is marked non-interactive and hidden by the
    sidebar's default filter (1 of 32 sessions on this host).
19. **A keyed request bypasses a OneCLI proxy** (LB-B5/B6): when the
    ambient proxy is OneCLI-marked, a request carrying the configured key
    goes direct. That is proven on garageserver (V1); a host that can reach
    Google ONLY through its OneCLI proxy pauses AI naming with a
    `direct_unreachable` WARN (nothing consumed) until a key route works.
    An ordinary (unmarked) proxy is still honored.
20. **The key's generation quota is unverified until deploy** (LB-B9; V1 ran
    GETs only): the first `session_names.generation_started`/`generation_failed`
    lines after deploy show it. Without quota naming latches (`Throttled`
    or `Capability`) and first-message names keep working.
21. **An older binary sharing `~/.freshell` could fight the self-heal**
    (LB-B12): worktree and dev servers default to `$HOME/.freshell` unless
    `FRESHELL_HOME` is set, and an older binary still applies imports, so a
    healed record could be re-labelled and healed back. This is
    pre-existing development practice; isolating `FRESHELL_HOME` for
    worktree servers avoids it. Not fixed here.
22. **Managed-runtime rigs can flake when they are not run alone** (LB-B15):
    the cause of the baseline's parallel timeouts is inferred, not proven;
    the local-only rules run every managed case alone.
23. **Fixed by Task 14** (the text below records the gap as Task 8 left
    it). **Tab titles the old merge already wrote stay** (Task 8 review). Task 8
    stops new "Shell agent"/"Recovered Shell agent"/"OpenCode agent" writes,
    but nothing rewrites a title an earlier merge stored on an unrenamed
    shell tab (shell tabs are not session-owned). `getTabDisplayTitle`
    treats only `Tab N` and the derived label as no title, so a single-pane
    shell tab with no pane title keeps showing "Shell agent" (Task 8 pins
    this: `a stored "Shell agent" title is visible on a single-pane shell
    tab`). It heals the next time the shell sets a window title (OSC 0/2,
    for example bash's default prompt on Ubuntu): that live write replaces
    both the tab title and the pane title (`TerminalView.tsx` title
    handler). A shell that never sets a title keeps the label until the
    tab is renamed. Session-owned tabs get the saved name from the Task 7
    mirror once their record is known. A possible client-only follow-up:
    have `getTabDisplayTitle` treat a provider/mode label
    (`isDefaultOrDerivedName` with the tab's folder and mode) as no title
    on a tab without `titleSetByUser`; projections that copy the stored
    title (`GET /api/tabs`, the tabs registry) would still carry it until
    a write replaces it. Task 14 took the stored-state route instead of
    that display-only one: one store middleware heals the stored title, so
    the display, the persisted layout, `GET /api/tabs` and the registry
    agree for every open tab. What it leaves: Residuals 24 and 25.
24. **Old closed-tab and other-device registry records keep their stored
    label** (Task 14 receipt, open concern 1). The heal runs on the tabs
    open in a window. A closed-tab record, or another device's record,
    written before the deploy keeps its old `tabName` ("Shell agent") in
    the Tabs view list and in the server's saved tabs registry, so the
    registry agrees with the display only for open tabs. Opening such a
    record from the Tabs view makes a new tab, which heals at once (it
    passes the heal); the old closed record keeps its label. Another
    device's open tabs heal when that device loads the new client. Nothing
    rewrites a record that stays closed; it drops out of the Tabs view after
    the closed-tab retention period (30 days at most). A possible
    client-only follow-up: have the Tabs view show a record's `tabName`
    through the same classifier.
25. **A live window title that is itself a provider label heals too**
    (Task 14 review). A tab title's writer is not recorded, so on a tab
    without a rename the heal cannot tell a stored "Shell agent" from a
    window title a program set to the same kind of label (a program in a
    shell titling the window "opencode", "claude" or "Shell agent"). Such a
    title becomes "Tab N". A single-pane tab still shows it, through the
    pane title the same window-title write stores; a split tab shows its
    derived label until the program sets a different title. Any other
    window title is never healed. A possible follow-up: write the pane
    title before the tab title in the window-title handler
    (`TerminalView.tsx`) and exempt a tab title equal to one of its own
    terminal panes' stored titles (the old merge wrote tab titles only).
26. **Clearing the Settings Gemini key takes effect after restart.** A
    nonempty Settings key replaces the running server's key, including one
    supplied by `GOOGLE_GENERATIVE_AI_API_KEY` at startup. An empty field
    does not clear the in-memory key; after restart the environment key
    still wins, so remove it too when disabling key-based AI naming.

### Out-of-scope finding for Dan (pre-existing, not fixed here)
**A managed shell is not re-adopted after a web-server restart on `main`
today** (V3, G53). In `runtime-terminal-continuity-rust.spec.ts` P2-G01,
twice on 1c7e4dff7: after the first graceful web restart the client's
`terminal.attach` for the original managed terminal got `INVALID_TERMINAL_ID`,
the server logged `client_restore_unavailable … "reason":"dead_live_handle"`,
and the client started a new terminal (`src/components/TerminalView.tsx:6695-6710`),
so the inventory grew to 3 souls while the original container kept running.
This is a durable-souls reattach bug, not a naming bug; this plan does not
change it and proves managed restart naming at Rust integration level
instead (Task 10). Evidence: `scratchpad/lb-validate/report-3.md` and
`scratchpad/lb-validate/v3/` (`run2-attempt2.log`, `run2b.log`,
`run2-artifacts/`). It needs its own plan; Dan decides when.

## Decisions (resolved)

Dan decided these on 2026-10-22; no product question is open.

1. **No repair tool.** The repair route, CLI verb, plan id, evidence files
   and runbook are dropped. Junk names heal through the self-heal rule
   (Ranking and self-heal); names that are not recognizable junk stay
   (Residual 12).
2. **AI naming uses the Gemini key Dan entered in Settings.** No dedicated
   naming proxy (Dan: it "seems like a hack"). A configured key always wins;
   without a key the server keeps today's inherited OneCLI route and logs a
   WARN. A keyed request goes direct when the ambient proxy is OneCLI's,
   and through the ambient proxy otherwise (coordinator decision on
   LB-B5/B6; on Dan's host it goes direct, Residual 19).
3. **Known failing tests.** The 7 managed-runtime tests failing on `main`
   are waived; the branch must not add failures.
4. **Delivery.** One branch, one PR at the end. Dan approved creating and
   merging it: "Build, code review, check, and if it was gnarly recheck a
   few times (max 5). Then land on main via PR." Deploying and restarting
   the live server still needs his "APPROVED".
   The resumed run uses the additional allowance and stop-on-pass rule in User Request.
5. **Conversation switch.** No carry-forward. As the existing contract says,
   the pane adopts the new conversation's name, or its fallback until it
   has one.

## Load-bearing validation

**Status: closed after two rounds.** Round 1 validated V1–V5 (below);
round 2 reviewed only the rev 3 changes (`scratchpad/plan/lb-round2-assumptions.md`,
B1–B15) and falsified nothing; its findings were applied as plan changes or
accepted residuals (table after the V table).

Round 1 checked five assumptions (read-only). Verdicts and the coordinator's
binding decisions are in `scratchpad/plan/lb-ledger.md` ("Round 1
results"); the evidence is in `scratchpad/lb-validate/report-0.md` (V1),
`report-1.md` (V2), `report-2.md` (V4, V5) and `report-3.md` (V3). Every
decision below is applied in the plan; nothing is pending.

| ID | What was checked | Verdict | Applied where |
|---|---|---|---|
| V1 | Keyed Gemini requests with Dan's Settings key, direct and through the inherited OneCLI gateway; env override on the live process | **Confirmed.** 200 both ways (identical bodies); the gateway refuses only no key (403) and a bad key (**400**), both with an `access_restricted` body; no env key on live pid 1612620; the key is the `AQ.` form, which the log scrubber misses (G48, G49) | "Generation capability", as amended by LB-B5/B6: the key route goes direct (`.no_proxy()`) when the ambient proxy is OneCLI-marked, and honors other ambient proxies; OneCLI-style error bodies on any non-2xx (including 400) are `Capability`; `proxy_tls` by downcasting the rustls certificate error; `AQ.` scrubbing; the e2e fake behaves like the real gateway (Task 6); Residual 19 |
| V2 | Parse-cache re-derivation (LB-A4), background arming (LB-A5), self-heal vs. sweep pre-checks (N2) | **A4 falsified** (unchanged files keep cached rows; 164 live rows start with a new tag). **A5 bounded** (141 sessions, at most 423 calls, if re-derived). **N2 confirmed with conditions C1–C5** | Task 5: targeted invalidation in `load_cache_file` (no schema bump); re-absorb at rest; the prompt-input guard; C5. Task 4: C1–C4. "Self-heal rule": the conditions and the ~190 one-time rewrites; Residual 16 |
| V3 | The local-only Docker managed-runtime lane (LB-A8) | **Falsified as planned.** The lane works when a managed case runs alone, but `runtime-terminal-continuity-rust.spec.ts` P2-G01 is red on `main` (a reattach bug), its serial describe skips later cases, and its P2-G04 is paid (G53) | Global Constraints local-only rules (exact `--grep`, three `env -u` flags, `--list` first, `chromium_headless_shell-1208`, rigs run alone); Task 8's new `managed-runtime-names-local-rust.spec.ts` with WebSocket-drop shapes; Task 10's Rust integration test for restart naming; Task 13 Step 3; the out-of-scope finding |
| V4 | Reconstructed managed tabs carry a resolvable identity (LB-A12) | **Falsified in general; holds only when the soul has a native session id** (G51) | Task 8: no inventory or server change; session ownership only for `isScopedPaneContent`; the `terminal.session.associated` unit test; Residual 17 |
| V5 | Wrapper tags as system context everywhere (LB-A18) | **Falsified for the Claude caveat** (it is followed by command/stdout records, sometimes `<system-reminder>`); **confirmed for the three Codex tags** (G39, G52) | Task 5: shared tag lists with the full tag set, the real Claude fixture shape and the mixed record, the pinned `user_message_count` change; Task 1: leading-tag check only; Residual 18 |

Round 2 dispositions (coordinator, binding; also appended to
`scratchpad/plan/lb-ledger.md`):

| ID | Finding | Disposition | Applied where |
|---|---|---|---|
| B1 | ~190 heals plus re-absorb and baseline commits, each a full-document transaction, could starve renames and binds after deploy | Plan change: one sweep maintenance transaction per pass, at most 25 records; native baselines staged and persisted by it | "Self-heal rule" (batched sweep writes), native observation details, Task 4 files and test |
| B2 | The Rust restart test drove only reconcile adoption | Plan change: the helper is tested at every adopt/create entry; production's restart path is broken today by P2-G01 | Task 10 |
| B3 | The local cases would pass on `main` | Plan change: assert stored `tab.title`/`updatedAt` (or a reload with names unavailable), use an unrenamed shell tab, red receipts required | Task 8 |
| B4, B14 | Grant-free managed OpenCode start; WebSocket-only drop re-attaches the same terminal | Deferred to implementation with explicit fallbacks (drop the OpenCode case; or fall back to unit and integration coverage), recorded in the receipt | Task 8 |
| B5, B6 | The inherited OneCLI token may not outlive its agent; key pass-through for `generateContent` POSTs unproven | Plan change: a keyed request goes direct when the ambient proxy is OneCLI-marked (direct proven by V1), else through the ambient proxy; direct connect failure → `Capability{direct_unreachable}`; the e2e asserts keyed requests never traverse the fake OneCLI proxy | "Generation capability", Task 6, Residual 19 |
| B7 | `system-reminder` and command tags could flip many Claude sessions to non-interactive | Accepted; shared lists kept; pinned by a two-real-prompts test | Task 5, Residual 18 |
| B8 | An automation rename to the session's folder name would apply and then heal away | Plan change: automation renames are classified with the target's best-known folder and refused with `default_label` | "Ranking and self-heal" table, Task 4, Residual 11 |
| B9 | Generation quota for Dan's key | Accepted residual: confirmed at deploy by the first generation log lines | Residual 20, Task 13 report |
| B10 | A 429 rewritten by the gateway could latch as `Capability` | Plan change: 429 is classified before the OneCLI-body rule | "Generation capability", Task 6 |
| B11 | A tag-led message the extraction still returns could be re-parsed every boot | Plan change: per-entry first-message rules stamp; each stale entry re-parsed once | Task 5 |
| B12 | An older binary sharing `~/.freshell` could fight the self-heal | Accepted residual (pre-existing dev practice) | Residual 21 |
| B13 | The `AQ.` pattern may not cover the whole key | Plan change: the configured key value itself is redacted too | "Generation capability", Task 6 |
| B15 | Parallel managed rigs as the cause of the baseline timeouts | Accepted residual (flakiness when not run alone) | Residual 22, Global Constraints |

## Review dispositions

### Plan review 1
Review: `/tmp/claude-1000/-home-dan-code-freshell/b0e858cc-c789-4cc8-aba4-46c81f21d8b8/scratchpad/plan/critique-1.md`.
Every point was checked against the code; all were accepted except where
noted. Items marked "superseded" were accepted at the time and then replaced
by Dan's 2026-10-22 charter change.

- A1 accepted (mirror reads records only; G33; data-safety unit test).
- A2, A3 superseded: they shaped the repair tool, which Dan removed. The
  part of A2 that still matters (never demote a name a person may have
  typed) carries over: the self-heal rule touches only names the classifier
  recognizes, and Task 3 lets an import-owned record lose a bind collision
  only when its name is a default label.
- A4–A8 accepted (fold-side exhaustion; helper in freshell-freshagent with
  corrected callers; ensure_pending retry and unbound-row tick; acknowledge-
  only after completion with no stored ids and no backup; folder sources
  named per use, limit pinned).
- B9, B12, B14 accepted. B10 superseded: routing is by credential with a
  configured key always first; there is no dedicated naming proxy. B11
  superseded: no carry-forward; a conversation switch adopts the new
  session's name, as the existing contract says. B15 accepted and now
  applies to the self-heal rule: Task 4 rewrites the pre-check comments and
  its sweep test proves the pre-checks do not skip a self-heal record.
- B13 accepted: Task 12 Step 0 diagnoses on current main first. Correction to
  the review: #851's `EmissionGate` covers only classified capacity errors;
  the live spam is the generic errored trigger, which #851 does not gate.
- C16–C23 accepted. C21: the Claude terminal fake is
  `test/e2e-browser/fixtures/providers/fake-claude.mjs`, not
  `fixtures/fake-claude.mjs`. C17 is refined by LB-A13 below.
- D24 superseded: one PR at the end, approved by Dan; no early PR. D25
  accepted (dependency noted); D26 no longer applies (the post-completion
  create path was dropped).
- E accepted (explicit line edits, now in Task 13; mirror module renamed
  `savedNameTabTitleMirror.ts`).
- F accepted; the `.no_proxy()` question is now V1.
- G accepted (single placeholder line; outcome nesting; `pnpm run test:server
  <filter>` for freshell-server; base now 1c7e4dff7).
- Added beyond the review: RC12 (171 names that are tool wrapper text);
  fixed in Task 5, and the existing ones heal through the self-heal rule.

### Load-bearing review, round 1
Source: `scratchpad/plan/lb-round1-assumptions.md` (IDs prefixed LB- here)
and the coordinator's dispositions in `scratchpad/plan/lb-ledger.md`.

- LB-A1 resolved: Task 11 prunes nothing, so an older binary keeps its
  acknowledged-candidate gate.
- LB-A3 resolved: proxy/connect/TLS errors on proxied requests classify as
  `Capability` (Task 6).
- LB-A6 resolved: the first native observation records the baseline and
  replaces at equal rank only for a self-heal record (Task 4).
- LB-A9 resolved: an import-owned record loses a bind collision only when
  its name is a default label (Task 3).
- LB-A10, LB-A11 resolved: carry-forward dropped; tests drive the identity
  retarget directly and the e2e switch signal is an implementation detail
  (Task 10).
- LB-A13 resolved: the mirror e2e uses a test-only names-unavailable server
  switch or the persisted layout title (Task 7).
- LB-A14 resolved: `Throttled` latches with a growing re-probe (Task 6).
- LB-A20 resolved: the per-window pre-migration sidecar is off the capture
  allow-list (Task 2, G44).
- LB-A21 resolved: the retrier re-submits the captured observation with its
  original location stamp (Task 4, G46).
- LB-A4, LB-A5 → V2; LB-A8 → V3; LB-A12 → V4; LB-A18 → V5 (all validated
  in round 1 and applied; see "Load-bearing validation").
- LB-A2, LB-A7, LB-A15–LB-A17 moot (dedicated proxy and repair removed).

### Load-bearing review, round 2
Source: `scratchpad/plan/lb-round2-assumptions.md` (B1–B15). No
falsifications; every item was applied as a plan change or accepted as a
residual per the coordinator's dispositions (table in "Load-bearing
validation"; also in `scratchpad/plan/lb-ledger.md`). The loop is closed.
- LB-A19 accepted as Residual 15.
