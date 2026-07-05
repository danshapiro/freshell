import { defineConfig, devices } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { externalTargetConfigured } from '../../../test/e2e-browser/helpers/external-target.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const e2eDir = path.resolve(__dirname, '../../../test/e2e-browser')

/**
 * T3 oracle Playwright config — the SAME e2e-browser specs, made targetable at
 * an arbitrary server URL so the Rust port can be graded by the identical suite.
 *
 * Grade the ORIGINAL (local baseline, single-worker, no flake-hiding retries):
 *   npx playwright test --config port/oracle/t3/playwright.target.config.ts
 *
 * Grade the PORT (or any running server) — point at it, skip the build:
 *   FRESHELL_E2E_TARGET_URL=http://127.0.0.1:PORT \
 *   FRESHELL_E2E_TARGET_TOKEN=<token> \
 *   npx playwright test --config port/oracle/t3/playwright.target.config.ts
 *
 * The committed visual baselines under specs/*-snapshots/*-chromium-linux.png
 * are the goldens; because the frontend is unchanged in the port, the port's
 * rendered UI must still match them (this host is chromium-linux).
 *
 * Notes:
 * - Single worker + no parallelism: when targeting ONE external server, tests
 *   must not race each other on shared server state.
 * - retries default to 0 so flakes surface as findings; override with
 *   FRESHELL_E2E_RETRIES to re-classify flaky-vs-hard.
 */

// Specs that own their server lifecycle (spawn/restart their OWN local
// TestServer, or read the server's local filesystem). These cannot be pointed
// at an arbitrary external URL, so they are excluded when targeting external.
// The port's restart/recovery + filesystem parity are graded by T0/T1/T2 and by
// port-local variants of these flows, not by pointing this suite at a URL.
const NOT_EXTERNALLY_TARGETABLE = [
  '**/server-restart-recovery.spec.ts',
  '**/settings-persistence-split.spec.ts',
  '**/freshopencode-restart-recovery.spec.ts',
  '**/freshopencode-db-history.spec.ts',
  '**/freshopencode-first-send-reload-repro.spec.ts',
  '**/opencode-restart-recovery.spec.ts',
]

const external = externalTargetConfigured()

export default defineConfig({
  testDir: path.join(e2eDir, 'specs'),
  testIgnore: external ? NOT_EXTERNALLY_TARGETABLE : [],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  workers: 1,
  retries: Number(process.env.FRESHELL_E2E_RETRIES ?? 0),
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [['list']],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  globalSetup: path.join(__dirname, 'global-setup.target.ts'),
  globalTeardown: path.join(e2eDir, 'global-teardown.ts'),
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
