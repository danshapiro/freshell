import { defineConfig } from '@playwright/test'
import baseConfig from './playwright.config.js'
import { LOCAL_ONLY_SPECS } from './playwright.config.js'

// Cloud Run Playwright config.
//
// Extends the base playwright.config.ts and overrides only the cloud-specific
// settings. The base config is Rust-only, so cloud inherits its fixture contract.
//
// Key differences from base:
// - No globalSetup/globalTeardown: the Docker image pre-builds dist/client and
//   the Rust binary, so there's no build step to run.
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
export const CLOUD_SKIP_SPECS = [
  // Provider-pane boot/lifecycle pipelines under parallel load: these
  // specs install hermetic FAKE opencode CLIs (fixtures/fake-opencode.cjs on
  // the spawned server's PATH), so no network binary is required — the
  // cloud lane excludes them because it does not guarantee provider-boot
  // timing under 2-CPU/2-worker contention (the same class that bursts on
  // the 48-worker local lane). (freshopencode-model-picker.spec.ts IS
  // cloud-legal: every fetch is routed and the sidecar is suppressed via
  // the test harness, so it needs no binary and no pane lifecycle.)
  'freshopencode-db-history.spec.ts',
  'freshopencode-restart-recovery.spec.ts',
  'freshopencode-first-send-reload-repro.spec.ts',
  // Same provider-lifecycle-timing class as its model above, plus a
  // backoff-guarded daemon respawn window: 2-CPU/2-worker cloud contention
  // cannot guarantee daemon-death + re-warm timing. Cloud PR coverage for
  // the incident class is carried by the cloud-legal
  // freshopencode-snapshot-409-recovery.spec.ts; this spec is the local-lane
  // end-to-end proof.
  'freshopencode-daemon-death-selfheal.spec.ts',
  'opencode-restart-recovery.spec.ts',
  'opencode-terminal-restore-rust.spec.ts',
  // Requires codex binary
  'codex-terminal-bounce-rust.spec.ts',
  'codex-terminal-restore-rust.spec.ts',
  // Requires amplifier/claude binary
  'amplifier-restore-rust.spec.ts',
  'remote-tab-linkage-rust.spec.ts',
  // Provider-pane lifecycle surfaces over mocked WS/REST (no binaries
  // needed): excluded because its server-side layout-sync/registry
  // propagation and settings-modal render waits are timing-sensitive under
  // cloud load.
  'fresh-agent-centralization-smoke.spec.ts',
  // Environment-sensitive: viewport rendering differs in cloud
  'mobile-viewport.spec.ts',
  // Environment-sensitive: timing-sensitive status transitions
  'pane-activity-indicator.spec.ts',
  // Environment-sensitive: timing-sensitive localStorage persistence
  'rest-tab-persistence.spec.ts',
  // Rust-only PATH shadow proof requires the local Rust fixture and is not a
  // cloud-compatible match-all run.
  'term28-path-shadow-rust.spec.ts',
  // Environment-sensitive: idle grace period timing + shade transition
  // depends on precise wall-clock scheduling that differs in cloud
  'truly-idle-alerting.spec.ts',
  // Environment-sensitive: scrollback boundary Unicode verification is
  // timing-sensitive under cloud resource constraints
  'term13-scrollback-boundary.spec.ts',
  // Environment-sensitive: checkpoint/rewind with fake codex sidecar
  // exceeds 120s timeout under cloud resource constraints
  'agent-checkpoint-rewind.spec.ts',
  // Local-only receipts need provider binaries or a host Docker supervisor
  // and broker. Their positive selectors are exported by the base config.
  ...LOCAL_ONLY_SPECS.map(({ spec }) => spec),
]

// Test titles to exclude via grepInvert (keeps the spec file but skips
// specific tests within it). Must be RegExp, not strings.
export const CLOUD_SKIP_TITLES = [
  // Screenshot comparison fails due to font rendering differences in cloud
  /new JS asset after the click/,
]

// The Cloud Run entrypoint sets this per task. The JSON report is consumed
// before the container exits so recovered retries can be retained in Cloud
// Logging instead of disappearing with the task filesystem.
const retryEvidenceReportPath = process.env.FRESHELL_CLOUD_RETRY_REPORT_PATH

export default defineConfig({
  ...baseConfig,
  globalSetup: undefined,
  globalTeardown: undefined,
  forbidOnly: true,
  retries: 2,
  workers: 2,
  use: {
    ...baseConfig.use,
    // Keep the first failed attempt's trace, even when a later retry passes.
    // The Cloud receipt associates evidence only with that failed attempt.
    trace: 'retain-on-first-failure',
  },
  reporter: [
    ['line'],
    ['html', { open: 'never' }],
    ...(retryEvidenceReportPath ? [['json', { outputFile: retryEvidenceReportPath }]] : []),
  ],
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
