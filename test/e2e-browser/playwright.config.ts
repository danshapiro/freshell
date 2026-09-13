import { defineConfig, devices } from '@playwright/test'

/** Match-all browser projects exclude only the separately selected live-CLI smoke. */
export const CONTINUITY_SMOKE_SPEC = /continuity-smoke\.spec\.ts$/
export const MATCH_ALL_TEST_IGNORE = [CONTINUITY_SMOKE_SPEC]

/**
 * These specs require locally installed provider binaries. Cloud selection must
 * never stand in for their receipt; `selector` is the positive local command.
 */
export const LOCAL_ONLY_SPECS = [{
  spec: 'mcp-qa-smoke-rust.spec.ts',
  selector: '--project=chromium test/e2e-browser/specs/mcp-qa-smoke-rust.spec.ts',
  classification: 'local-only-provider-binary',
}]

const continuityRequested = process.env.FRESHELL_SMOKE
  || process.argv.includes('--project=continuity-smoke')
  || (process.argv.includes('--project')
    && process.argv[process.argv.indexOf('--project') + 1] === 'continuity-smoke')

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github']]
    : [['html', { open: 'never' }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
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
      use: devices['Desktop Chrome'],
      testIgnore: MATCH_ALL_TEST_IGNORE,
    },
    ...(continuityRequested ? [{
      name: 'continuity-smoke',
      use: devices['Desktop Chrome'],
      testMatch: [CONTINUITY_SMOKE_SPEC],
    }] : []),
    // CI deliberately expands the application lane to Firefox and WebKit.
    // Local and Cloud Run lanes stay Chromium-only because the latter has no
    // browser binaries for the other projects and the former is the fast
    // developer default; the selection contract tests pin both choices.
    ...(process.env.CI ? [
      {
        name: 'firefox',
        use: devices['Desktop Firefox'],
        testIgnore: MATCH_ALL_TEST_IGNORE,
      },
      {
        name: 'webkit',
        use: devices['Desktop Safari'],
        testIgnore: MATCH_ALL_TEST_IGNORE,
      },
    ] : []),
  ],
})
