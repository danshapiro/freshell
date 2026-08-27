import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const configDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(configDir, '../..')

/**
 * The checkout-free Electron runtime lane is intentionally separate from the
 * ordinary Electron unit tests. It owns a staged artifact and must never
 * silently pass when its integration test is not selected.
 */
export default defineConfig({
  root: projectRoot,
  test: {
    environment: 'node',
    include: ['test/integration/electron/**/*.test.ts'],
    exclude: ['docs/plans/**'],
    passWithNoTests: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
