import { defineConfig, devices } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'

if (process.env.FRESHELL_DESTRUCTIVE_SANDBOX !== '1') {
  throw new Error(
    'deployment compatibility browser proof requires FRESHELL_DESTRUCTIVE_SANDBOX=1',
  )
}
if (!path.resolve(os.tmpdir()).startsWith('/tmp')) {
  throw new Error(`Playwright deployment sandbox must use container /tmp, got ${os.tmpdir()}`)
}

export default defineConfig({
  testDir: '.',
  testMatch: /deployment-compatibility\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 3_600_000,
  expect: {
    timeout: 30_000,
  },
  outputDir: '/tmp/freshell-deploy-playwright-output',
  reporter: [['line']],
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
})
