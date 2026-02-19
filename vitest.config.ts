import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup/dom.ts'],
    exclude: ['**/node_modules/**', '**/.worktrees/**', 'docs/plans/**'],
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
