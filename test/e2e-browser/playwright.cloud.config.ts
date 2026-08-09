import { defineConfig } from '@playwright/test'
import baseConfig from './playwright.config.js'

// Cloud Run Playwright config.
//
// Extends the base playwright.config.ts and overrides only the cloud-specific
// settings. This avoids duplicating the MATRIX_SPECS / RUST_ONLY_SPECS / project
// testMatch lists, which are tightly coupled to the base config.
//
// Key differences from base:
// - No globalSetup/globalTeardown: the Docker image pre-builds dist/client +
//   dist/server and the Rust binary, so there's no build step to run.
// - workers: 2, retries: 2: cloud is a CI-like environment.
// - forbidOnly: true: always enforce in cloud.
// - Reporter: line + html (open: 'never'): line for log parsing, html for
//   artifact extraction.
// - Only chromium-family projects: the base config already excludes
//   firefox/webkit when CI is unset (which it is in cloud), and
//   continuity-smoke is opt-in via FRESHELL_SMOKE (also unset). We filter
//   defensively to be safe.
// - Sharding is handled by the entrypoint script which passes --shard=x/y
//   based on CLOUD_RUN_TASK_INDEX/CLOUD_RUN_TASK_COUNT.
export default defineConfig({
  ...baseConfig,
  globalSetup: undefined,
  globalTeardown: undefined,
  forbidOnly: true,
  retries: 2,
  workers: 2,
  reporter: [['line'], ['html', { open: 'never' }]],
  projects: (baseConfig.projects ?? []).filter(
    (p) => !['firefox', 'webkit', 'continuity-smoke'].includes(p.name ?? ''),
  ),
})
