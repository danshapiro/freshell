import './sanitize-test-env.js'
import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(CONFIG_DIR, '../..')

export default defineConfig({
  root: PROJECT_ROOT,
  resolve: {
    alias: {
      '@': path.resolve(PROJECT_ROOT, './src'),
      '@test': path.resolve(PROJECT_ROOT, './test'),
      '@shared': path.resolve(PROJECT_ROOT, './shared'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'test/integration/tooling/source-runtime-rust.test.ts',
      'test/integration/tooling/coordinator-watchdog-replay.test.ts',
      'test/integration/tooling/claude-fixture-processes.test.ts',
    ],
    exclude: ['docs/plans/**', '**/node_modules/**', '**/.worktrees/**'],
    passWithNoTests: false,
    testTimeout: 90_000,
    hookTimeout: 30_000,
    pool: 'threads',
    isolate: true,
    minWorkers: 1,
    maxWorkers: 1,
    fileParallelism: false,
  },
})
