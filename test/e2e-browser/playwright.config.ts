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
const MATRIX_SPECS = [
  /server-restart-recovery\.spec\.ts$/,
  /settings-persistence-split\.spec\.ts$/,
  /harness-02-matrix-bite\.spec\.ts$/,
  /terminal-lifecycle\.spec\.ts$/,
  // HARNESS-02 Finding 1 -- round out the acceptance-named scenario
  // categories (settings, session, terminal, browser-pane, multi-client).
  // These three use only the generic `e2eServerKind`-routed fixtures (no
  // server-kind-specific assertions), so they run identically against both
  // projects.
  /browser-pane\.spec\.ts$/,
  /multi-client\.spec\.ts$/,
  /session-directory-matrix\.spec\.ts$/,
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
  /ws-ping-pong-matrix\.spec\.ts$/,
  // SESSION-01 narrowed-MISSING closure -- sidebar-click resume (Codex leg
  // runs on both kinds; the Amplifier leg self-skips on legacy via an
  // explicit `test.skip` KNOWN DIVERGENCE call). See sidebar-click-resume.spec.ts.
  /sidebar-click-resume\.spec\.ts$/,
]

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github']]
    : [['html', { open: 'on-failure' }]],
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
        // TERM-28 (`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`):
        // proves the Rust `freshell-terminal`/`freshell-platform` PATH-only
        // bare-command resolution fix. Rust-only -- the bug is in the Rust
        // port's portable-pty integration; legacy node-pty is unaffected
        // (bare names go straight to PATH search, no cwd-first branch).
        /term28-path-shadow-rust\.spec\.ts$/,
      ],
    },
    ...(process.env.CI ? [
      {
        name: 'firefox',
        use: { ...devices['Desktop Firefox'] },
      },
      {
        name: 'webkit',
        use: { ...devices['Desktop Safari'] },
      },
    ] : []),
  ],
})
