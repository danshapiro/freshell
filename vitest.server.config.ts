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

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@test': path.resolve(__dirname, './test'),
      '@shared': path.resolve(__dirname, './shared'),
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
      'test/integration/session-repair.test.ts',
      'test/integration/session-search-e2e.test.ts',
      'test/integration/extension-system.test.ts',
    ],
    exclude: [
      'docs/plans/**',
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
