// Dedicated vitest config for E2E helper unit tests (e.g., test-server.test.ts).
// These tests verify the E2E test infrastructure itself and run in a Node
// environment. They are NOT run by `npm test` (which uses the root vitest
// configs); instead, they are run explicitly during E2E helper development.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['helpers/**/*.test.ts'],
    testTimeout: 60_000, // TestServer startup can take a while
    hookTimeout: 30_000,
  },
})
