import './sanitize-test-env.js'
import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export default defineConfig({
  root: PROJECT_ROOT,
  test: {
    environment: 'node',
    include: ['test/integration/tooling/claude-fixture-processes-native.test.ts'],
    exclude: ['**/node_modules/**', '**/.worktrees/**'],
    passWithNoTests: false,
    testTimeout: 60_000,
    hookTimeout: 15_000,
    pool: 'threads',
    isolate: true,
    maxWorkers: 1,
    fileParallelism: false,
  },
})
