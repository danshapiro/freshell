import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  fullyParallel: false, // Electron tests share state; run serially
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github']]
    : [['html', { open: 'on-failure' }]],
  timeout: 120_000, // Electron startup can be slow
  expect: {
    timeout: 15_000,
  },
  use: {
    trace: 'on',
    screenshot: 'on',
    video: 'on',
  },
})
