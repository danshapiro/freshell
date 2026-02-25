import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
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
    exclude: [
      '**/node_modules/**',
      '**/.worktrees/**',
      'docs/plans/**',
      // Server tests run under vitest.server.config.ts (node environment)
      'test/server/**',
      'test/unit/server/**',
      'test/integration/server/**',
      'test/integration/session-repair.test.ts',
      'test/integration/session-search-e2e.test.ts',
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@test': path.resolve(__dirname, './test'),
      '@shared': path.resolve(__dirname, './shared'),
    },
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
