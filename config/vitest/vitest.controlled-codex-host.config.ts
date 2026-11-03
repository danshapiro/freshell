import './sanitize-test-env.js'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
if (!process.env.XDG_CACHE_HOME) throw new Error('controlled host test requires its owned cache directory')

export default defineConfig({
  root,
  cacheDir: path.join(process.env.XDG_CACHE_HOME, 'vite'),
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom', 'react-redux', '@reduxjs/toolkit'] },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup/dom.ts'],
    include: ['test/runtime/controlled-codex-host-client.test.tsx'],
    alias: {
      '@': path.join(root, 'src'),
      '@test': path.join(root, 'test'),
      '@shared': path.join(root, 'shared'),
    },
    passWithNoTests: false,
    testTimeout: 60_000,
    maxWorkers: 1,
  },
})
