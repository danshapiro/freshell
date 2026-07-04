// Vitest inherits NODE_ENV from the parent process. Override when running
// inside a production Freshell server so this stays a plain node run.
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
 * Dedicated config for the Rust/Tauri port's contract-freeze tests
 * (`test/unit/port/**`). Node environment, NO globalSetup — the drift guard is a
 * pure in-process import + compare against the committed `port/contract/`
 * artifacts, so it must not spawn a server or rebuild dist.
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
    include: ['test/unit/port/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
