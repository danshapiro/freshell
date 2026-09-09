import { defineConfig, devices } from '@playwright/test'
import { DEFAULT_TEST_TIMEOUT_MS } from './helpers/test-harness.js'

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
}, {
  spec: 'runtime-terminal-continuity-rust.spec.ts',
  selector: '--project=chromium test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts',
  classification: 'local-only-docker-supervisor',
}, {
  spec: 'runtime-provider-resurrection-rust.spec.ts',
  selector: '--project=chromium test/e2e-browser/specs/runtime-provider-resurrection-rust.spec.ts',
  classification: 'local-only-docker-supervisor',
}, {
  spec: 'runtime-opencode-provider-qualification-rust.spec.ts',
  selector: '--project=chromium test/e2e-browser/specs/runtime-opencode-provider-qualification-rust.spec.ts',
  classification: 'local-only-docker-supervisor',
}, {
  spec: 'runtime-tabs-rehydrate-rust.spec.ts',
  selector: '--project=chromium test/e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.ts',
  classification: 'local-only-docker-supervisor',
}, {
  spec: 'runtime-lost-soul-notice-rust.spec.ts',
  selector: '--project=chromium test/e2e-browser/specs/runtime-lost-soul-notice-rust.spec.ts',
  classification: 'local-only-docker-supervisor',
}, {
  spec: 'runtime-chaos-rust.spec.ts',
  selector: '--project=chromium test/e2e-browser/specs/runtime-chaos-rust.spec.ts',
  classification: 'local-only-docker-supervisor',
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
  // The per-test deadline default, imported from the helpers as the single
  // source of truth (delta review r9): this is the TEST BODY ceiling on
  // every lane — the cloud wiring never modifies it (the boot chain's
  // larger allowance is the freshellPage fixture's OWN timeout, see
  // helpers/fixtures.ts); a spec may declare its own larger body deadline
  // wherever its body envelope genuinely needs one.
  timeout: DEFAULT_TEST_TIMEOUT_MS,
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
