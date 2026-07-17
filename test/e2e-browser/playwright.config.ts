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
      // only needs to run once, under this project.
      testMatch: [...MATRIX_SPECS, /harness-01-rust-server\.spec\.ts$/],
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
