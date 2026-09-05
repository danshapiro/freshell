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
// - Cloud-incompatible spec files excluded via testIgnore (see CLOUD_SKIP_SPECS).
// - Screenshot comparison tests excluded via grepInvert (see CLOUD_SKIP_TITLES).
// - Sharding is handled by the entrypoint script which assigns spec files to
//   shards using duration-aware greedy bin-packing (not Playwright's --shard).

// Spec files that cannot run in the Cloud Run Docker image because they
// require external CLI binaries (opencode, codex, claude/amplifier) that
// are not installed, or because they depend on environment-specific
// rendering/timing that differs in cloud.
const CLOUD_SKIP_SPECS = [
  // Requires opencode binary
  // (freshopencode-model-picker.spec.ts is cloud-legal: every fetch is routed
  // and the sidecar is suppressed via the test harness, so it needs no binary)
  'freshopencode-db-history.spec.ts',
  'freshopencode-restart-recovery.spec.ts',
  'freshopencode-first-send-reload-repro.spec.ts',
  'opencode-restart-recovery.spec.ts',
  'opencode-terminal-restore-rust.spec.ts',
  // Requires codex binary
  'codex-terminal-bounce-rust.spec.ts',
  'codex-terminal-restore-rust.spec.ts',
  // Requires amplifier/claude binary
  'amplifier-restore-rust.spec.ts',
  'remote-tab-linkage-rust.spec.ts',
  // Requires fresh-agent binaries (claude/codex/opencode sidecars)
  'fresh-agent-centralization-smoke.spec.ts',
  // Environment-sensitive: viewport rendering differs in cloud
  'mobile-viewport.spec.ts',
  // Environment-sensitive: timing-sensitive status transitions
  'pane-activity-indicator.spec.ts',
  // Environment-sensitive: timing-sensitive localStorage persistence
  'rest-tab-persistence.spec.ts',
  // Rust-only: asserts e2eServerKind === 'rust' but runs under chromium
  // project (not in RUST_ONLY_SPECS — pre-existing config gap)
  'term28-path-shadow-rust.spec.ts',
  // Server-build mismatch reload: the Cloud Run image builds WITHOUT git
  // metadata (.dockerignore drops .git), so the Rust bake and the Vite
  // define are both "unknown" there and the client's compare is inert BY
  // DESIGN — a mismatched ready can never trigger a reload on that lane.
  // Coverage lives on the local rust-chromium project.
  'server-build-mismatch-rust.spec.ts',
  // Environment-sensitive: page lifecycle (pagehide/unload) timing differs
  // in cloud containers; passes locally but flakes in cloud
  'tabs-client-retire.spec.ts',
  // Environment-sensitive: idle grace period timing + shade transition
  // depends on precise wall-clock scheduling that differs in cloud
  'truly-idle-alerting.spec.ts',
  // Environment-sensitive: scrollback boundary Unicode verification is
  // timing-sensitive under cloud resource constraints
  'term13-scrollback-boundary.spec.ts',
  // Environment-sensitive: checkpoint/rewind with fake codex sidecar
  // exceeds 120s timeout under cloud resource constraints
  'agent-checkpoint-rewind.spec.ts',
  // Requires codex binary (creates mode:'codex' tabs via MCP)
  'mcp-qa-smoke-rust.spec.ts',
]

// Test titles to exclude via grepInvert (keeps the spec file but skips
// specific tests within it). Must be RegExp, not strings.
const CLOUD_SKIP_TITLES = [
  // Screenshot comparison fails due to font rendering differences in cloud
  /new JS asset after the click/,
]

export default defineConfig({
  ...baseConfig,
  globalSetup: undefined,
  globalTeardown: undefined,
  forbidOnly: true,
  retries: 2,
  workers: 2,
  reporter: [['line'], ['html', { open: 'never' }]],
  grepInvert: CLOUD_SKIP_TITLES,
  projects: (baseConfig.projects ?? [])
    .filter(
      (p) => !['firefox', 'webkit', 'continuity-smoke'].includes(p.name ?? ''),
    )
    .map((p) => ({
      ...p,
      testIgnore: [
        ...(p.testIgnore ?? []),
        ...CLOUD_SKIP_SPECS.map((s) => `**/${s}`),
      ],
    })),
})
