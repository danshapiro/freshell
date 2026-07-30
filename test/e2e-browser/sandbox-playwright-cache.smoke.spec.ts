import { expect, test } from '@playwright/test'
import { constants, readFileSync } from 'node:fs'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const playwrightVersion = require('playwright/package.json').version as string

test('starts lockfile-matched Chromium from the sandbox cache', async ({ browser }) => {
  const stamp = path.join(
    os.homedir(),
    '.cache/ms-playwright/.freshell-playwright-version',
  )
  expect(readFileSync(stamp, 'utf8')).toBe(`${playwrightVersion}\n`)
  const executable = require('playwright').chromium.executablePath() as string
  await access(executable, constants.X_OK)
  expect(browser.version()).not.toBe('')
})
