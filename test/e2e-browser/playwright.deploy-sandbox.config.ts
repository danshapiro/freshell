import { defineConfig, devices } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'

if (process.env.FRESHELL_DESTRUCTIVE_SANDBOX !== '1') {
  throw new Error(
    'deployment compatibility browser proof requires FRESHELL_DESTRUCTIVE_SANDBOX=1',
  )
}
const tmpRelative = path.relative('/tmp', path.resolve(os.tmpdir()))
if (
  tmpRelative === '..'
  || tmpRelative.startsWith(`..${path.sep}`)
  || path.isAbsolute(tmpRelative)
) {
  throw new Error(`Playwright deployment sandbox must use container /tmp, got ${os.tmpdir()}`)
}

export default defineConfig({
  testDir: '.',
  testMatch: /(deployment-compatibility|sandbox-playwright-cache\.smoke)\.spec\.ts$/,
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
