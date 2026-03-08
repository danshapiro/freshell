import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  define: {
    // Override NODE_ENV for tests so React loads its development build
    // (which supports act()). Without this, the worktree inherits
    // NODE_ENV=production from the parent process environment.
    'process.env.NODE_ENV': JSON.stringify('test'),
  },
  test: {
    environment: 'node',
    include: [
      'test/unit/electron/**/*.test.ts',
      'test/unit/electron/**/*.test.tsx',
    ],
    exclude: ['docs/plans/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
    alias: {
      '@electron': path.resolve(__dirname, './electron'),
    },
  },
})
