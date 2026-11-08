import { defineConfig } from '@playwright/test'
import parentConfig from './test/e2e-browser/playwright.config.ts'

const parentRoot = '/home/dan/code/freshell/.worktrees/task4-parent-8844'

export default defineConfig({
  ...parentConfig,
  testDir: `${parentRoot}/test/e2e-browser/specs`,
  globalSetup: `${parentRoot}/test/e2e-browser/global-setup.ts`,
  globalTeardown: `${parentRoot}/test/e2e-browser/global-teardown.ts`,
  projects: parentConfig.projects?.map((project) => (
    project.name === 'chromium'
      ? { ...project, use: { ...project.use, e2eServerKind: 'rust' }, testIgnore: undefined }
      : project
  )),
})
