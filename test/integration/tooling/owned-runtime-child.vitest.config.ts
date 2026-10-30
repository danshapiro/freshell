import { defineConfig } from 'vitest/config'

// Explicit Docker-only entrypoint; excluded from ordinary unit/Cloud runs.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/tooling/owned-runtime-child.test.ts'],
    testTimeout: 30_000,
  },
})
