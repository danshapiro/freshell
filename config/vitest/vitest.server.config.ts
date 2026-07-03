// Vitest inherits NODE_ENV from the parent process. Override when running
// inside a production Freshell server.
if (process.env.NODE_ENV === 'production') {
  process.env.NODE_ENV = 'test'
}

import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '../..')

export default defineConfig({
  root: projectRoot,
  resolve: {
    alias: {
      '@': path.resolve(projectRoot, './src'),
      '@test': path.resolve(projectRoot, './test'),
      '@shared': path.resolve(projectRoot, './shared'),
    },
  },
  test: {
    environment: 'node',
    globalSetup: ['./test/setup/server-global-setup.ts'],
    include: [
      'test/server/**/*.test.ts',
      'test/unit/server/**/*.test.ts',
      'test/unit/visible-first/**/*.test.ts',
      'test/integration/server/**/*.test.ts',
      'test/integration/real/**/*.test.ts',
      'test/integration/session-repair.test.ts',
      'test/integration/session-search-e2e.test.ts',
      'test/integration/extension-system.test.ts',
    ],
    exclude: [
      'docs/plans/**',
      'test/integration/server/codex-real-provider-smoke.test.ts',
      'test/integration/server/opencode-serve-real-provider-smoke.test.ts',
      'test/unit/visible-first/slow-network-controller.test.ts',
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Maximum parallelization settings
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
        isolate: true,
      },
    },
    fileParallelism: true,
    maxConcurrency: 10,
    sequence: {
      shuffle: true, // Detect order-dependent tests
    },
  },
})
