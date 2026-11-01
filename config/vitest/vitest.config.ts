// Strip ambient shell env (proxies, FRESHELL_BIND_HOST) before anything else — see sanitize-test-env.ts.
import './sanitize-test-env.js'

// Vitest inherits NODE_ENV from the parent process. When running inside a
// production Freshell server (NODE_ENV=production), React loads its production
// build which disables act() — breaking all component tests.
if (process.env.NODE_ENV === 'production') {
  process.env.NODE_ENV = 'test'
}

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '../..')
const realProviderContractsEnabled = process.env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS === '1'
// vitest-cloud.sh sets this only for the source-only Cloud Run image.
const sourceOnlyCloudVitest = process.env.TEST_MODE === 'vitest'

export default defineConfig({
  root: projectRoot,
  plugins: [react()],
  resolve: {
    // Prevent duplicate React instances in git worktrees (where node_modules
    // may be symlinked to the main repo). Without this, Vite can resolve
    // real-path and symlink-path copies as different modules.
    dedupe: ['react', 'react-dom', 'react-redux', '@reduxjs/toolkit'],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup/dom.ts'],
    globalSetup: ['./test/setup/runtime-build-preflight.ts'],
    exclude: [
      'test/runtime/**',
      '**/node_modules/**',
      '**/.worktrees/**',
      '**/.claude/worktrees/**',
      'docs/plans/**',
      // Port contract-freeze tests run under config/vitest/vitest.port.config.ts (node environment)
      'test/unit/port/**',
      // These integration trees own their own runtime/artifact setup.
      'test/integration/tooling/**',
      'test/integration/electron/**',
      // These suites require a local managed runtime and Git checkout. Their
      // shared teardown helper is covered by source-only tooling unit tests.
      ...(sourceOnlyCloudVitest ? [
        'test/integration/server/fresh-agent-parity.test.ts',
        'test/integration/server/managed-provider-parity.test.ts',
      ] : []),
      // This one helper executes the browser selection contract in Vitest.
      // Every other browser file remains in its existing separate workflow.
      'test/e2e-browser/!(helpers)/**',
      'test/e2e-browser/*.ts',
      'test/e2e-browser/helpers/!(selection-nonvacuity.test.ts)',
      'test/e2e-browser/helpers/*/**',
      ...(realProviderContractsEnabled ? [] : ['test/integration/real/**']),
      // Electron tests run under config/vitest/vitest.electron.config.ts (node environment)
      'test/unit/electron/**',
      // Electron E2E tests run under Playwright, not Vitest
      'test/e2e-electron/**',
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
    alias: {
      '@': path.resolve(projectRoot, './src'),
      '@test': path.resolve(projectRoot, './test'),
      '@shared': path.resolve(projectRoot, './shared'),
    },
    // Maximum parallelization settings
    pool: 'threads',
    isolate: true,
    fileParallelism: true,
    maxConcurrency: 10,
    sequence: {
      shuffle: true, // Detect order-dependent tests
    },
  },
})
