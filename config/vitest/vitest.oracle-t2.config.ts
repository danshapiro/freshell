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
 * Dedicated config for the equivalence oracle's T2 LIVE behavioral-invariant
 * tests (`test/integration/port/oracle/**`).
 *
 * These boot a REAL external freshell server, seed provider auth into an
 * isolated HOME, and make a LIVE (cheap) model call — so, like vitest.oracle:
 *   - NO globalSetup (the harness owns build + boot + reap of its own server).
 *   - node environment; VERY generous timeout: a Kimi round-trip can take
 *     30–120s on top of a cold server boot.
 *   - single-fork / no file parallelism so spawned ports & pids never contend
 *     and only one live turn is in flight at a time.
 *
 * DELIBERATELY separate from vitest.oracle.config.ts (the fast T0/T1 rungs) and
 * NOT wired into the shared test-coordinator/full-suite. Run explicitly and
 * only with the gate ON:
 *   FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:oracle:t2
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
    include: ['test/integration/port/oracle/**/*.test.ts'],
    testTimeout: 240000,
    hookTimeout: 240000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    fileParallelism: false,
  },
})
