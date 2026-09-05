// Deliberately NOT importing ./sanitize-test-env.js: this config's package
// script does not set FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1, and its tests
// spawn real provider CLIs that may need ambient proxy egress on some hosts.

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
      'test/integration/server/codex-real-provider-smoke.test.ts',
    ],
    testTimeout: 60000,
    hookTimeout: 30000,
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
        isolate: true,
      },
    },
  },
})
