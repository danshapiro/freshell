import { defineConfig } from 'vitest/config'
import baseConfig from '../../../config/vitest/vitest.config.js'

// Signals and cleanup run only through the disposable sandbox. This explicit
// entry avoids running these fixtures in the ordinary cloud/local unit lane.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['test/unit/tooling/sandbox-test.sandbox.ts', 'test/unit/tooling/run-rust-tests.test.ts', 'test/unit/tooling/rust-launcher-resources.sandbox.ts'],
    // Process-budget probes must not compete with other files for the same
    // container's PID allowance. Preserve concurrency inside each probe.
    fileParallelism: false,
  },
})
