import { defineConfig, devices } from '@playwright/test'

// HARNESS-02 -- the curated "matrix smoke" set: specs that are verified to
// run identically against BOTH the legacy Node server and the owned Rust
// server (via the `e2eServerKind` project option, see helpers/fixtures.ts).
// Deliberately a SUBSET of `./specs`, not the whole suite -- running every
// spec against a freshly-built Rust binary on every default `test:e2e`
// invocation would multiply CI runtime and require the Rust toolchain for a
// run that previously needed only Node. Grow this list as more specs are
// verified against the Rust target; run the full suite against Rust
// explicitly via `--project=rust-chromium` with a broader `testMatch`
// override when that verification work happens.
export const MATRIX_SPECS = [
  /server-restart-recovery\.spec\.ts$/,
  /settings-persistence-split\.spec\.ts$/,
  // HARNESS-03 — deterministic provider-fixture contract (fixture-only:
  // boots NO server; both matrix legs run the identical assertions, which is
  // itself the proof the fixtures are server-kind-independent).
  /harness-03-provider-fixtures\.spec\.ts$/,
  // CFG-04 — legacy browser-preference seeding (one-shot consume + marker).
  // Authored under the df1 deferred-Playwright policy (worker-authored,
  // close-out-campaign-executed); see docs/plans/df1-evidence/CFG-04.md.
  /cfg04-legacy-browser-seed\.spec\.ts$/,
  /harness-02-matrix-bite\.spec\.ts$/,
  // HARNESS-14 — controllable server clock: advance/freeze/resume/reset the
  // shared server clock from one serial spec, deterministic fixture-timer
  // ordering (idle cleanup) with zero wall sleeps, and the normal-build
  // absence proof. Legacy is a true parity control (identical surface).
  /harness-14-server-clock\.spec\.ts$/,
  // HARNESS-04 — multi-provider session corpus builder contract: fixture-only
  // manifest/hash proof + legacy-open session-directory semantics + sidebar
  // spot-check. The server leg pins kind:'legacy' under both projects (Rust
  // indexing of this corpus is owed by later SESSION-* items).
  /harness-04-session-corpus\.spec\.ts$/,
  /terminal-lifecycle\.spec\.ts$/,
  // HARNESS-02 Finding 1 -- round out the acceptance-named scenario
  // categories (settings, session, terminal, browser-pane, multi-client).
  // These three use only the generic `e2eServerKind`-routed fixtures (no
  // server-kind-specific assertions), so they run identically against both
  // projects.
  /browser-pane\.spec\.ts$/,
  /multi-client\.spec\.ts$/,
  /session-directory-matrix\.spec\.ts$/,
  // SESSION-16 — malformed/partial provider-data tolerance: quarantine classes never
  // render, tolerated classes (valid-prefix truncation, invalid UTF-8) do, and a
  // completed partial record lands as exactly one live addition. Runs against BOTH
  // server kinds (legacy is the behavioral control — incl. the amplifier legs, wired
  // since the provider exists on this base). Deferred-policy probe spec; see
  // docs/plans/df1-evidence/SESSION-16.md for the per-leg probe classification.
  /session-malformed-data\.spec\.ts$/,
  // SESSION-13 — server-wide first-chat exclusion controls: edit both knobs via
  // the real Settings UI in profile A, exact sidebar membership across providers
  // (claude/codex/amplifier + the firstUserMessage-less opencode control) in A
  // AND a fresh isolated profile B, then reload + server restart persistence.
  // Deferred-with-probe policy spec; per-leg probe classification lives in
  // docs/plans/df1-evidence/SESSION-13.md.
  /session-13-first-chat-exclusions\.spec\.ts$/,
  // Bulletproof-restore acceptance suite: terminal reload/restart, FreshCodex
  // reload (no new session minted), historical session open (pane title +
  // non-blank content), and mid-life exit surfacing. Restore is a core
  // feature, so this runs against both server kinds on every matrix pass.
  /restore-matrix\.spec\.ts$/,
  // SYNC-05 -- expected-restart quiet-reconnect outer spec (authored ahead
  // of the TERM-22/SAFE-11/TAURI-30 implementation wave). See
  // restore-sync05.spec.ts for the full acceptance-text mirror.
  /restore-sync05\.spec\.ts$/,
  // Permanent regression pin for the double-restart-mid-restore production
  // incident (client fix in commit cd35c24c): a FreshCodex session must
  // survive two rapid, overlapping server restarts without a blank
  // replacement pane, and a genuinely-missing durable thread must degrade
  // to a bounded, recoverable lost state. See restore-double-restart.spec.ts.
  /restore-double-restart\.spec\.ts$/,
  // AGENT-08 -- OpenCode continuity via REST (`/api/tabs` +
  // `/api/panes/:id/send-keys`): one durable id across repeat sends, a
  // different id per pane. See agent-continuity-matrix.spec.ts.
  /agent-continuity-matrix\.spec\.ts$/,
  // Narrow live settings reload (safety.autoKillIdleMinutes / terminal.scrollback
  // take effect via PATCH /api/settings without a restart) -- runs against
  // both server kinds as a parity control. See settings-live-reload.spec.ts.
  /settings-live-reload\.spec\.ts$/,
  // TERM-13 -- two scrollback settings, Unicode-integrity, and
  // search-at-boundary closure -- a true parity control on both server
  // kinds. See term13-scrollback-boundary.spec.ts.
  /term13-scrollback-boundary\.spec\.ts$/,
  /ws-ping-pong-matrix\.spec\.ts$/,
  // BROWSER-01 — same-origin HTTP reverse proxy: CSP/XFO fixture renders in a
  // Browser pane, frameLocator GET/POST/streaming, exact upstream inputs
  // (raw path+query, urlencoded body, cookie auth) + visible responses.
  // Legacy is a true parity control (identical contract). See
  // specs/browser01-proxy.spec.ts and docs/plans/df1/BROWSER-01.md.
  /browser01-proxy\.spec\.ts$/,
  // SYNC-06 -- resume-by-id parity: the pinned sidebar Resume button and the
  // paste-then-Enter resume path against BOTH servers (POST /api/sessions/resolve
  // + sessionResolve flag now exist on the Rust server too, with the hardened
  // response surface -- degraded/providerErrors/unsearchedProviders/homeDir).
  /resume-button\.spec\.ts$/,
  // SESSION-01 narrowed-MISSING closure -- sidebar-click resume (Codex leg
  // runs on both kinds; the Amplifier leg self-skips on legacy via an
  // explicit `test.skip` KNOWN DIVERGENCE call). See sidebar-click-resume.spec.ts.
  /sidebar-click-resume\.spec\.ts$/,
  // SAFE-01/SAFE-03/CFG-03 checklist closures -- auth/origin/config-backup
  // matrices. Legacy is a true parity control for SAFE-01 (identical
  // startup-token messages/order); legacy is a documented KNOWN-DIVERGENCE
  // control for SAFE-03 and CFG-03 (both are deliberate Rust-only
  // hardening beyond an advisory-only/data-losing legacy behavior -- see
  // each spec's file doc comment).
  /safe01-auth-matrix\.spec\.ts$/,
  /safe03-origin-matrix\.spec\.ts$/,
  /cfg03-backup-restore\.spec\.ts$/,
  // Truly-idle alerting (terminal.idle): end-to-end blue -> green + one alert
  // edge + tab shade -> activate clears. Both legs live: the rust
  // terminal.idle emitter shipped with feat/rust-terminal-activity-idle.
  /truly-idle-alerting\.spec\.ts$/,
  // AGENT-14 -- checkpoint create/list/metadata/restore driven through the
  // real "Rewind code to here" UI gesture (hover, click, confirm dialog,
  // POST restore, verify file bytes). Legacy is a true parity control: the
  // checkpoint routes and the fresh-agent checkpoint UI are shared code
  // paths, not a Rust-only feature. See agent-checkpoint-rewind.spec.ts.
  /agent-checkpoint-rewind\.spec\.ts$/,
  // SESSION-05 -- project colors on History project headers: real color
  // gesture in one browser, broadcast-driven update in a second context,
  // reload/restart persistence, unrelated project unchanged. Legacy is a
  // true parity control (same additive page `projectColors` channel on
  // both servers). See project-colors-matrix.spec.ts.
  /project-colors-matrix\.spec\.ts$/,
  // HARNESS-05 — raw HTTP/WS clients self-verify: deterministic echo/error
  // fixture legs + capability legs (delayed hello, malformed-frame
  // termination, slow-consumer pause, raw orchestration REST) against BOTH
  // server kinds. See docs/plans/df1/HARNESS-05.md.
  /harness-05-raw-clients\.spec\.ts$/,
  // HARNESS-06 -- deterministic misc-fixture smoke (HTTP/WS/hot-reload
  // target, file/SMB trees, fake editor, fake Gemini, fake Kilroy runtime,
  // signed update feed, trusted HTTPS). Server-kind-agnostic: the spec
  // requests only Playwright base fixtures (the worker-lazy `testServer`
  // never boots), so it runs identically under all three projects. See
  // harness-06-misc-fixtures.spec.ts + docs/plans/df1-evidence/HARNESS-06.md.
  /harness-06-misc-fixtures\.spec\.ts$/,
  // TERM-04 — terminal.create requestId dedupe (retry/reconnect/lost-reply/
  // two-clients → one PTY/one terminalId/one pane owner/one fixture launch).
  // Serviced by BOTH server kinds (legacy's server-global
  // `createdTerminalByRequestId` settled cache is the parity source), so
  // legacy-chromium runs as a true parity control; the default `chromium`
  // match-all project also picks it up (with the fixture-default legacy
  // server) — browser-independent content, standard for MATRIX_SPECS. See
  // docs/plans/df1-evidence/TERM-04.md.
  /terminal-create-dedupe\.spec\.ts$/,
  // HARNESS-12 — leak/resource measurement gate: a bounded create/send/close
  // loop + restart + stop must return to a bounded baseline (no listening-port,
  // fd-handle, process, RSS, or socket-queue leaks) on BOTH server kinds; the
  // collector logic itself is unit-tested fixture-driven in
  // helpers/leak-metrics.test.ts. See leak-metrics.spec.ts and
  // docs/plans/df1-evidence/HARNESS-12.md.
  /leak-metrics\.spec\.ts$/,
  // AUTO-01 — ui.layout.sync authoritative: visible-UI-driven mutations read
  // back exactly through /api/layout/snapshot (+ raw-frame normalization
  // leg). Legacy is a true parity control (identical LayoutStore semantics).
  // The default `chromium` match-all project also picks it up (fixture-
  // default legacy server): test 2 re-asserts its synthetic ui.layout.sync
  // per poll iteration because the store is whole-snapshot last-write-wins
  // and the page's real client mirror keeps syncing — so all three projects
  // are deterministic. Authored under the df1 deferred-Playwright policy; see
  // docs/plans/df1-evidence/AUTO-01.md.
  /layout-sync-authoritative\.spec\.ts$/,
  // Task 21 (naming-persistence sweep) -- cross-surface title convergence
  // (pane header / sidebar / History / Overview / automation PATCH renames
  // must converge on both surfaces). Pins EDEV-09; the client fixes are
  // shared code, so legacy is a true regression control proving they didn't
  // regress Node behavior. See title-sync-convergence.spec.ts.
  /title-sync-convergence\.spec\.ts$/,
  // HOST-STATS (host-pressure-pane plan, Task 10) — Host Stats pane smoke:
  // picker create, verdict strip/CPU tile, refresh interaction (Collecting
  // state + age label), Disks fallback em-dash contract, tab-switch liveness,
  // reload restore. Assertions are backend-agnostic (the Rust lane renders
  // zero-shape values identically), so legacy is a true parity control. See
  // test/e2e-browser/specs/host-stats-pane.spec.ts.
  /host-stats-pane\.spec\.ts$/,
]

// CONTINUITY TRIO: rust-only specs kept out of every match-all project
// (their e2eServerKind:'rust' guard FAILS under the fixture-default 'legacy').
// Exported (no behavior change) so test/e2e-browser/playwright.gate01.config.ts
// (GATE-01) can testIgnore the SAME array instead of drifting a copy.
export const RUST_ONLY_SPECS = [
  /continuity-smoke\.spec\.ts$/,
  /deploy-tab-diff-rust\.spec\.ts$/,
  // COMPOUND-RESTART: drives RustServer.restartAbrupt() (SIGKILL + reboot),
  // an owned-fixture capability the default/legacy seam does not implement.
  /compound-restart-rust\.spec\.ts$/,
  // Restore-resilience contract wall (P0.1 "the ruler") -- imports RustServer
  // directly for restartAbrupt(); see docs/plans/2026-07-24-restore-contract-wall.md
  /restore-contract-wall-rust\.spec\.ts$/,
  // TERM-15/TERM-16 terminal-mode CLI activity: hard `expect(e2eServerKind
  // ).toBe('rust')` guard (predates this list's convention; fails under the
  // fixture-default 'legacy' when the match-all chromium project picks it up).
  /terminal-activity-rust\.spec\.ts$/,
  // Lane A: busy-aware idle gate + queue-empty reason (imports RustServer
  // directly for restartAbrupt() and two concurrent servers).
  /idle-gate-semantics-rust\.spec\.ts$/,
  // AMPLIFIER EVENTS-LANE RESILIENCE (Lane B): imports RustServer directly
  // for restartAbrupt(); drives the Rust activity hub's events lane.
  /amplifier-lane-resilience-rust\.spec\.ts$/,
  /codex-status-completeness-rust\.spec\.ts$/,
  // LANE E create protection: restore-storm contract; imports RustServer
  // directly for restartAbrupt(). See docs/plans/2026-07-25-rust-create-protection.md
  /create-protection-restore-storm-rust\.spec\.ts$/,
  // LANE E create protection: frozen-client RATE_LIMITED ladder vs the Rust
  // limiter. See docs/plans/2026-07-25-rust-create-protection.md
  /create-rate-limit-ladder-rust\.spec\.ts$/,
  // LANE E create protection: two concurrent RustServers, storm-isolation
  // proof. See docs/plans/2026-07-25-rust-create-protection.md
  /create-protection-isolation-rust\.spec\.ts$/,
  // Server-build mismatch auto-reload: injects a mismatched ready.buildId
  // through the test harness and proves ONE sentinel-guarded reload.
  // Rust-only: owns a RustServer directly (see the spec header).
  /server-build-mismatch-rust\.spec\.ts$/,
  /launch-retry-restart-rust\.spec\.ts$/,
  /double-restart-terminal-restore-rust\.spec\.ts$/,
  /turn-complete-restart-resume-rust\.spec\.ts$/,
  // Lane A1 (P1.6): createRequestId stabilization — asserts the Rust REST
  // ingress mints the key (Uuid::simple format), so it must run against the
  // rust server only.
  /createrequestid-stabilization-rust\.spec\.ts$/,
  // P1.8 pane-identity ledger SIGKILL durability walls: imports RustServer
  // directly for restartAbrupt(). See docs/plans/2026-07-25-pane-identity-ledger.md
  /pane-ledger-restart-rust\.spec\.ts$/,
  // Freshclaude restart parity (P0.2 §2.8 items 2-4) -- imports RustServer for restartAbrupt()
  /freshclaude-restart-parity-rust\.spec\.ts$/,
  // Hidden-pane rebind (F8 / P1.11): imports RustServer directly for
  // restartAbrupt(); hidden panes must rebind without being revealed.
  /hidden-pane-rebind-rust\.spec\.ts$/,
  // Silent input loss (kata dtfn): imports RustServer directly for restart();
  // input typed in the reconnect-before-reattach window must arrive byte-exact.
  /silent-input-loss-rust\.spec\.ts$/,
  // Freshclaude zero-turn restart (kata 09v1): imports RustServer directly
  // for restartAbrupt(); a VISIBLE zero-turn pane must resume, never die.
  /freshclaude-zero-turn-restart-rust\.spec\.ts$/,
  // Wave-A integration preflight: cross-lane interaction proofs (A1xA3
  // ledger-join coherence, A2xA3 dual claude identity stores). Imports
  // RustServer directly for restartAbrupt().
  /wavea-interactions-rust\.spec\.ts$/,
  // Reconcile client adoption (Task 14): verdict-driven recovery with the
  // real SPA. Imports RustServer directly (restart()/restartAbrupt()).
  /reconcile-client-adoption-rust\.spec\.ts$/,
  // Lane C2 reconcile completion: fresh-agent verdict folding + D8 lease +
  // pre-verdict create hold. Imports RustServer directly (restartAbrupt()).
  /reconcile-completion-rust\.spec\.ts$/,
  // Lane B2 codex rollout locator: rust-only (legacy has no codex terminal
  // locator); imports the RustServer-backed harness for same-port restart.
  /codex-terminal-restore-rust\.spec\.ts$/,
  // B3/P1.9 recover-my-panes browser-loss recovery: drives the Rust-only
  // GET /api/recovery/inventory + RecoveryOfferPanel; imports RustServer
  // directly for restart(). See docs/plans/2026-07-26-recover-my-panes.md
  /recover-my-panes-rust\.spec\.ts$/,
  // P1.13 (Lane B4 Task 14): per-provider settings survive restart + codex
  // crash memory-loss banner. Imports RustServer directly for restartAbrupt().
  /freshagent-settings-resume-rust\.spec\.ts$/,
  // Task 6 (the-usual/freshagent-sessionref-regression): REST fresh-agent
  // `sessionRef` resume (durable + placeholder→durable via the pane ledger,
  // loud 4xx failures) + the tabs.sync registry placeholder clamp. Imports
  // RustServer directly for restartAbrupt().
  /fresh-agent-rest-resume-rust\.spec\.ts$/,
  // imports RustServer directly; restart()/ledger semantics are rust-only (P1.14)
  /sidebar-registry-sync-rust\.spec\.ts$/,
  // Lane D1: agent crash auto-resume — rust-server-only spec.
  /agent-crash-autoresume-rust\.spec\.ts$/,
  // Kata enn3: REST spawn-gate burst; owns its RustServer.
  // See docs/plans/2026-07-27-rest-spawn-gate.md
  /rest-spawn-gate-rust\.spec\.ts$/,
  // P0.2 lane D4: freshclaude durable identity across reload + SIGKILL +
  // stale-sessionRef dead_session guard. Imports RustServer for restartAbrupt().
  /freshclaude-identity-persistence-rust\.spec\.ts$/,
  // Signal-file rebind lane exists only on the Rust server (opencode_signal.rs).
  /opencode-rebind-rust\.spec\.ts$/,
  // CFG-01 — lossless config.json writes: seed-sentinels/deep-compare per
  // writer. Rust-only: the acceptance is PW-RUST and the Rust writer is a
  // deliberate strict superset of legacy (legacy's normalization rebuild
  // drops sibling serverSecrets; Rust preserves them). See
  // specs/cfg01-lossless-writes.spec.ts and docs/plans/df1-evidence/CFG-01.md.
  /cfg01-lossless-writes\.spec\.ts$/,
  // Task 21 -- auto-title pipeline + settings split boot OWNED RustServers
  // directly (per-test fake-Gemini seams / restart legs), so they only ever
  // run under the rust-chromium project.
  /auto-title-rust\.spec\.ts$/,
  /settings-split-rust\.spec\.ts$/,
  // Task 22 -- durable tabs registry (CFG-08/AUTO-15): raw-WS revision-guard
  // journeys + restart survival + corruption self-heal against per-test owned
  // RustServers (the durable `~/.freshell/tabs-registry/v1/` store is a
  // Rust-only feature of this sweep; legacy has no durable tabs store).
  /tabs-registry-persistence-rust\.spec\.ts$/,
  // Task 23 -- automation tab/pane/layout REST parity + git branch/dirty
  // badges: both boot OWNED per-test RustServers (isolated HOME, ephemeral
  // port; automation-layout test 3 needs a server NO client ever synced a
  // layout into), so they only ever run under the rust-chromium project.
  /automation-layout-rust\.spec\.ts$/,
  /git-badges-rust\.spec\.ts$/,
  // AGENT-04/05/06/07/24 — fresh-agent approval/question/compact/fork control
  // surfaces validated in-browser against hermetic provider fakes (owns
  // per-test RustServers; hard e2eServerKind==='rust' assertion per test).
  /fresh-agent-control-rust\.spec\.ts$/,
  // SESSION-02/03 soft delete + unmatched-/api/* 404-JSON contract wall:
  // owns its RustServer (isolated HOME, ephemeral port); the DELETE route
  // exists only on the Rust server.
  /session-delete-rust\.spec\.ts$/,
  // Remote tab linkage (STATE-SYNC FIX 1 / EDEV-07) — boots its own
  // RustServers, hard e2eServerKind==='rust' assertion per test; the legacy
  // tree has no amplifier provider registered at all (pre-existing gap fix).
  /remote-tab-linkage-rust\.spec\.ts$/,
  // Reconnect-revive acceptance: socket-drop/freeze revival; drives
  // RustServer + forceDisconnect + SIGSTOP (docs/plans/2026-08-22-reconnect-revive.md).
  /reconnect-revive-rust\.spec\.ts$/,
]

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github']]
    : // 'never' locally too: many concurrent agents run this suite, and
      // 'on-failure' auto-opens a report browser page (localhost:9323) at the
      // user on every failing run. View reports on demand with
      // `npx playwright show-report`.
      [['html', { open: 'never' }]],
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: RUST_ONLY_SPECS,
    },
    // HARNESS-02 -- the Node/Rust matrix. Both projects run the SAME spec
    // files (`MATRIX_SPECS`) over the SAME testDir; only the `e2eServerKind`
    // project option differs, selecting which real server implementation
    // `helpers/fixtures.ts`'s `testServer` fixture boots for the worker.
    {
      name: 'legacy-chromium',
      use: { ...devices['Desktop Chrome'], e2eServerKind: 'legacy' },
      testMatch: MATRIX_SPECS,
    },
    {
      name: 'rust-chromium',
      use: { ...devices['Desktop Chrome'], e2eServerKind: 'rust' },
      // Also includes the HARNESS-01 self-test, which always drives an owned
      // RustServer directly (independent of `e2eServerKind`) and therefore
      // only needs to run once, under this project. Also includes the
      // amplifier restore-across-restart spec
      // (`docs/plans/2026-07-18-amplifier-restore-spec.md`) -- the legacy
      // `server/` tree is FROZEN and predates upstream #514 (no amplifier
      // provider registered at all there, see `session-directory-matrix.spec.ts`'s
      // KNOWN DIVERGENCE notes), so this is a genuinely rust-only feature,
      // not a parity gap to gate per-assertion.
      testMatch: [
        ...MATRIX_SPECS,
        /harness-01-rust-server\.spec\.ts$/,
        /amplifier-restore-rust\.spec\.ts$/,
        /opencode-terminal-restore-rust\.spec\.ts$/,
        // TERM-15/TERM-16 — terminal-mode CLI activity (blue/busy), the
        // server-authoritative terminal.turn.complete, and the NEW
        // terminal.idle edge, all on the Rust activity engine
        // (`crates/freshell-activity` + `crates/freshell-ws/src/activity.rs`).
        // Rust-only: this is the Rust port's implementation of the legacy
        // activity engine (and the amplifier scenario has the same absent-
        // legacy-provider KNOWN DIVERGENCE as amplifier-restore-rust above).
        /terminal-activity-rust\.spec\.ts$/,
        // CODEX-BOUNCE (2026-07-22 incident regression): a sidebar-resumed
        // codex pane must re-resume (`codex resume <id>` argv) across a
        // server restart WITHOUT a page reload. Rust-only: the bug was the
        // Rust WS create path's codex-special resume derivation ignoring
        // `sessionRef` (legacy anchor `ws-handler.ts:2040-2047` was correct).
        /codex-terminal-bounce-rust\.spec\.ts$/,
        // Server-build mismatch auto-reload (the-usual/server-version-reload):
        // mismatched ready.buildId → one reload, sentinel suppresses repeats.
        /server-build-mismatch-rust\.spec\.ts$/,
        // MCP bridge pin (Slice 2, docs/plans/2026-07-18-agent-api-mcp-parity-spec.md
        // §6/§8.3): drives the UNMODIFIED legacy Node MCP stdio binary
        // against an owned, ephemeral Rust server. Rust-only (no legacy
        // equivalent needed -- see the spec's own doc comment in that file).
        /mcp-bridge-rust\.spec\.ts$/,
        // MCP QA smoke (the QA-lever payoff): full mode-matrix coverage
        // (shell/amplifier/opencode/codex/browser/editor/pane-ops) driven
        // through the same unmodified legacy MCP stdio binary. See
        // mcp-qa-smoke-rust.spec.ts's own doc comment.
        /mcp-qa-smoke-rust\.spec\.ts$/,
        // Lane C2 reconcile completion (see RUST_ONLY_SPECS entry above).
        /reconcile-completion-rust\.spec\.ts$/,
        // TERM-28 (`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`):
        // proves the Rust `freshell-terminal`/`freshell-platform` PATH-only
        // bare-command resolution fix. Rust-only -- the bug is in the Rust
        // port's portable-pty integration; legacy node-pty is unaffected
        // (bare names go straight to PATH search, no cwd-first branch).
        /term28-path-shadow-rust\.spec\.ts$/,
        // REST-TAB-PERSISTENCE (client tab-poisoning incident evidence,
        // `rest-tab-persistence.spec.ts`): legacy's frozen `server/` tree
        // predates upstream #514 (`05c6b1fa`) and has no `amplifier`
        // provider registered at all -- same KNOWN DIVERGENCE already
        // documented for `amplifier-restore-rust.spec.ts` above, so this is
        // an absent legacy feature on this branch, not a parity gap.
        /rest-tab-persistence\.spec\.ts$/,
        // REMOTE-TAB-LINKAGE (STATE-SYNC FIX 1 e2e proof, rust commit
        // 80772ff2): sidebar open-state + dedupe + restart durability for a
        // REST-created amplifier resume tab. Rust-only: same amplifier
        // KNOWN DIVERGENCE as amplifier-restore-rust.spec.ts above.
        /remote-tab-linkage-rust\.spec\.ts$/,
        // DIAG-03 — secret redaction + log rotation (small-limit, concurrent
        // writers, final shutdown flush). Rust-only: env-var-configurable
        // rotation limits are a deliberate Rust-only hardening feature; the
        // frozen legacy server/ tree has no equivalent. See
        // diag03-rotation-redaction-rust.spec.ts.
        /diag03-rotation-redaction-rust\.spec\.ts$/,
        // CONTINUITY TRIO deliverable 3: deploy tab-diff ritual acceptance
        // (capture -> restart -> verify OK; identity loss fails loudly + remediates).
        /deploy-tab-diff-rust\.spec\.ts$/,
        // COMPOUND-RESTART (state-sync resilience assessment §7's two
        // never-tested modes): abrupt SIGKILL death + revival, and server +
        // browser restarting together. Rust-only: requires the owned
        // RustServer.restartAbrupt() fixture capability.
        /compound-restart-rust\.spec\.ts$/,
        // Restore-resilience contract wall (P0.1 "the ruler") -- imports RustServer
        // directly for restartAbrupt(); see docs/plans/2026-07-24-restore-contract-wall.md
        /restore-contract-wall-rust\.spec\.ts$/,
        /idle-gate-semantics-rust\.spec\.ts$/,
        // AMPLIFIER EVENTS-LANE RESILIENCE (Lane B): rust-only, owns its
        // servers, exercises events.jsonl rotation + abrupt restart.
        /amplifier-lane-resilience-rust\.spec\.ts$/,
        // Rust-only: drives RustServer directly (restartAbrupt + raw WS frames).
        /codex-status-completeness-rust\.spec\.ts$/,
        // LANE E create protection: restore-storm contract; imports RustServer
        // directly for restartAbrupt(). See docs/plans/2026-07-25-rust-create-protection.md
        /create-protection-restore-storm-rust\.spec\.ts$/,
        // LANE E create protection: frozen-client RATE_LIMITED ladder vs the Rust
        // limiter. See docs/plans/2026-07-25-rust-create-protection.md
        /create-rate-limit-ladder-rust\.spec\.ts$/,
        // LANE E create protection: two concurrent RustServers, storm-isolation
        // proof. See docs/plans/2026-07-25-rust-create-protection.md
        /create-protection-isolation-rust\.spec\.ts$/,
        /launch-retry-restart-rust\.spec\.ts$/,
        /double-restart-terminal-restore-rust\.spec\.ts$/,
        /turn-complete-restart-resume-rust\.spec\.ts$/,
        // Lane A1 (P1.6): createRequestId stabilization — asserts the Rust REST
        // ingress mints the key (Uuid::simple format), so it must run against the
        // rust server only.
        /createrequestid-stabilization-rust\.spec\.ts$/,
        // P1.8 pane-identity ledger SIGKILL durability walls (spec §4.2):
        // identity rows/pending markers are durable within seconds of pane
        // creation and survive an abrupt SIGKILL + boot scan. Rust-only:
        // imports RustServer directly for restartAbrupt().
        /pane-ledger-restart-rust\.spec\.ts$/,
        // Freshclaude restart parity (P0.2 §2.8 items 2-4) -- imports RustServer for restartAbrupt()
        /freshclaude-restart-parity-rust\.spec\.ts$/,
        // Hidden-pane rebind (F8 / P1.11): imports RustServer directly for
        // restartAbrupt(); hidden panes must rebind without being revealed.
        /hidden-pane-rebind-rust\.spec\.ts$/,
        // Silent input loss (kata dtfn): imports RustServer directly for
        // restart(); input typed in the reconnect-before-reattach window must
        // arrive byte-exact in the recreated terminal.
        /silent-input-loss-rust\.spec\.ts$/,
        // Freshclaude zero-turn restart (kata 09v1): imports RustServer directly
        // for restartAbrupt(); a VISIBLE zero-turn pane must resume, never die.
        /freshclaude-zero-turn-restart-rust\.spec\.ts$/,
        // Wave-A integration preflight: cross-lane interaction proofs (A1xA3
        // ledger-join coherence, A2xA3 dual claude identity stores). Imports
        // RustServer directly for restartAbrupt().
        /wavea-interactions-rust\.spec\.ts$/,
        // Reconcile client adoption (Task 14): mixed-pane restart recovery,
        // batched dead-session adjudication, double-restart convergence --
        // all driven by pane.reconcile verdicts in the real SPA. Rust-only:
        // imports RustServer directly (restart()/restartAbrupt()).
        /reconcile-client-adoption-rust\.spec\.ts$/,
        // Lane B2 codex rollout locator: rust-only (legacy has no codex terminal
        // locator); imports the RustServer-backed harness for same-port restart.
        /codex-terminal-restore-rust\.spec\.ts$/,
        // B3/P1.9 recover-my-panes browser-loss recovery (offer, accept-resume,
        // mixed-kind, reload guard, decline, live no-restart). Rust-only:
        // drives GET /api/recovery/inventory; imports RustServer for restart().
        /recover-my-panes-rust\.spec\.ts$/,
        // P1.13 (Lane B4 Task 14): per-provider settings survive restart +
        // codex crash memory-loss banner. Imports RustServer directly for
        // restartAbrupt().
        /freshagent-settings-resume-rust\.spec\.ts$/,
        // Task 6 (see the RUST_ONLY_SPECS entry): REST fresh-agent resume +
        // registry placeholder clamp. Imports RustServer for restartAbrupt().
        /fresh-agent-rest-resume-rust\.spec\.ts$/,
        // P1.14 (Lane C1): sidebar/tab-registry sync pinning suite -- imports
        // RustServer directly; restart()/ledger semantics are rust-only.
        /sidebar-registry-sync-rust\.spec\.ts$/,
        // Lane D1: agent crash auto-resume — rust-server-only spec.
        /agent-crash-autoresume-rust\.spec\.ts$/,
        // Kata enn3: REST spawn-gate burst; owns its RustServer.
        // See docs/plans/2026-07-27-rest-spawn-gate.md
        /rest-spawn-gate-rust\.spec\.ts$/,
        // P0.2 lane D4: freshclaude durable identity across reload + SIGKILL +
        // stale-sessionRef dead_session guard. Imports RustServer for restartAbrupt().
        /freshclaude-identity-persistence-rust\.spec\.ts$/,
        // Signal-file rebind lane exists only on the Rust server (opencode_signal.rs).
        /opencode-rebind-rust\.spec\.ts$/,
        // CFG-01 — lossless config.json writes: seed sentinels + deep-compare
        // after every writer action/restart. Rust-only (superset guarantee —
        // see RUST_ONLY_SPECS entry + the spec's doc comment). Authored under
        // the df1 deferred-Playwright policy; see docs/plans/df1-evidence/CFG-01.md.
        /cfg01-lossless-writes\.spec\.ts$/,
        // Sidebar opencode rail fixes (Bug 1 + Bug 2): runs in BOTH matrix
        // projects — Node parity is part of the fix.
        /sidebar-opencode-rail\.spec\.ts$/,
        // Task 21 -- auto-title pipeline (background sweep dir ->
        // first-message -> Gemini AI ladder, generate-title route, terminal
        // summary route) against per-test owned RustServers with a local
        // fake Gemini on the Rust-only `FRESHELL_GEMINI_BASE_URL` seam
        // (validator-A1 documented superset; no legacy equivalent).
        /auto-title-rust\.spec\.ts$/,
        // Task 21 -- settings split (CFG-12): browser-local appearance vs
        // server-backed settings across two contexts + the RustServer
        // restart durability leg. Rust-only: the matrix sibling
        // (`settings-persistence-split.spec.ts`) depends on
        // `legacyLocalSettingsSeed` (CFG-04/SESSION-13, unimplemented in
        // Rust) and is `test.fail`-annotated on this project.
        /settings-split-rust\.spec\.ts$/,
        // Task 22 -- durable tabs registry across restart (CFG-08/AUTO-15):
        // cross-device restart survival, idempotent-retry/content-conflict/
        // stale/retire watermark semantics, and missing-object corruption
        // self-heal (manifest.json.invalid-* archive => empty). Rust-only:
        // the durable content-addressed store under
        // `<home>/.freshell/tabs-registry/v1/` exists only in the Rust
        // server on this branch.
        /tabs-registry-persistence-rust\.spec\.ts$/,
        // Task 23 -- automation tab/pane/layout REST parity over the shared
        // LayoutStore (AUTO-03/AUTO-06 + the AUTO-01 snapshot/rename slice)
        // against per-test owned RustServers, including the no-client
        // `{message:'no layout snapshot'}` degradation leg (which needs a
        // server NO page ever connected to). Rust-only: the LayoutStore-backed
        // automation routes are this sweep's Rust work; the frozen legacy
        // `server/` tree is not under test.
        /automation-layout-rust\.spec\.ts$/,
        // Task 23 -- git branch/dirty badges (TerminalMetaRegistry +
        // create-time git enrichment + handshake `terminal_meta` reload
        // persistence, Tasks 17-18). Covers git badge parity for
        // REST-created terminals via FreshAgentState post-create seeding.
        /git-badges-rust\.spec\.ts$/,
        // AGENT-04/05/06/07/24 (see the RUST_ONLY_SPECS entry): fresh-agent
        // approval/question/compact/fork PW-RUST validation across providers.
        /fresh-agent-control-rust\.spec\.ts$/,
        // SESSION-02/03 -- soft-delete route + unmatched-/api/* 404-JSON
        // contract wall (see RUST_ONLY_SPECS entry + the spec's doc comment).
        /session-delete-rust\.spec\.ts$/,
        // Reconnect-revive acceptance: socket-drop/freeze revival; drives
        // RustServer + forceDisconnect + SIGSTOP (see RUST_ONLY_SPECS entry).
        /reconnect-revive-rust\.spec\.ts$/,
      ],
    },
    // CONTINUITY SMOKE (pre-deploy gate): REAL freshell-server binary + REAL
    // codex/amplifier/claude CLIs from PATH. Run via `npm run smoke:continuity`.
    // Registered CONDITIONALLY (mirroring the CI-only browser projects below):
    // this is a pre-deploy gate that spawns real CLIs and hard-fails on
    // machines without provider auth (e.g. no readable ~/.codex/auth.json),
    // so it must never run in a bare project-less invocation like
    // `npm run test:e2e`. It is included only when explicitly requested via
    // FRESHELL_SMOKE=1 (set by the `smoke:continuity` npm script) or an
    // explicit `--project=continuity-smoke` CLI arg. The spec itself stays in
    // RUST_ONLY_SPECS so no match-all project ever picks it up even when the
    // project IS registered.
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
    ...(process.env.CI ? [
      {
        name: 'firefox',
        use: { ...devices['Desktop Firefox'] },
        testIgnore: RUST_ONLY_SPECS,
      },
      {
        name: 'webkit',
        use: { ...devices['Desktop Safari'] },
        testIgnore: RUST_ONLY_SPECS,
      },
    ] : []),
  ],
})
