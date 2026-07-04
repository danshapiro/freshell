// Vitest inherits NODE_ENV from the parent process. When this runs from inside
// a production Freshell server (NODE_ENV=production), force it back to `test`
// so the harness boots cleanly.
if (process.env.NODE_ENV === 'production') {
  process.env.NODE_ENV = 'test'
}

import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '../..')

/**
 * Dedicated config for the equivalence oracle's LIVE conformance tests
 * (`test/unit/port/oracle/**`).
 *
 * Unlike the fast contract-freeze drift guard (config/vitest/vitest.port.config.ts),
 * these tests boot a REAL external freshell server process via
 * `port/oracle/harness/external-server.ts`, so:
 *   - NO globalSetup: the harness ensures `dist/server/index.js` is built and
 *     boots/reaps its own isolated server. We must NOT trigger the server
 *     global-setup dist rebuild here.
 *   - node environment, generous 120s timeout for cold boot + first build.
 *   - single-fork / no file parallelism so spawned ports & pids never contend.
 *
 * NOT wired into the shared test-coordinator/full-suite — run explicitly via
 * `npm run test:oracle`.
 */
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
    include: ['test/unit/port/oracle/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    fileParallelism: false,
  },
})
