import { defineConfig } from 'vitest/config'

// This networkless integration suite needs the real Docker CLI, but no daemon.
// Its Unix socket is a private, in-process Docker API fixture.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/tooling/sandbox-mount.test.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
  },
})
