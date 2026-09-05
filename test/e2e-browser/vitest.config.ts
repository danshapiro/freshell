// Dedicated Vitest config for Rust fixture, shared-support, external-target,
// selection, and perf helper tests. These infrastructure tests run in Node,
// outside the root Vitest configs, during E2E helper development.
// Strip ambient shell env (proxies, FRESHELL_BIND_HOST) before anything else — see sanitize-test-env.ts.
import '../../config/vitest/sanitize-test-env.js'
import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../src'),
      '@test': path.resolve(__dirname, '../../test'),
      '@shared': path.resolve(__dirname, '../../shared'),
    },
  },
  test: {
    environment: 'node',
    root: __dirname,
    globalSetup: [path.resolve(__dirname, '../setup/e2e-browser-global-setup.ts')],
    include: ['helpers/**/*.test.ts', 'perf/**/*.test.ts'],
    testTimeout: 60_000, // RustServer startup can take a while
    hookTimeout: 30_000,
  },
})
