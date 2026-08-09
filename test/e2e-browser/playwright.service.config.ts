/**
 * Playwright service config with a local (default) / remote (cloud) switch.
 *
 * - Local (default): `npx playwright test --config test/e2e-browser/playwright.service.config.ts`
 *   Re-exports the base config unchanged. No cloud connection, no `az login`
 *   required. Identical to running against `playwright.config.ts` directly.
 *
 * - Remote (cloud):  `PLAYWRIGHT_CLOUD=1 npx playwright test --config test/e2e-browser/playwright.service.config.ts --workers=20`
 *   Wraps the base config with Azure Playwright cloud browsers + the Azure
 *   reporter (uploads HTML report + traces to the Azure portal). Requires
 *   `az login` (Entra ID) and `PLAYWRIGHT_SERVICE_URL` in `.env`.
 *
 * The switch is the `PLAYWRIGHT_CLOUD` env var so local stays the zero-config
 * default — machines without `az` or cloud access are unaffected.
 */
import 'dotenv/config'
import { defineConfig } from '@playwright/test'
import { DefaultAzureCredential } from '@azure/identity'
import { createAzurePlaywrightConfig } from '@azure/playwright'
import baseConfig from './playwright.config.js'

const useCloud = process.env.PLAYWRIGHT_CLOUD === '1'

if (useCloud && !process.env.PLAYWRIGHT_SERVICE_URL) {
  throw new Error(
    'PLAYWRIGHT_CLOUD=1 but PLAYWRIGHT_SERVICE_URL is not set. ' +
      'Add it to .env (the wss://.../browsers endpoint from the Azure portal).',
  )
}

export default useCloud
  ? defineConfig(
      baseConfig,
      createAzurePlaywrightConfig(baseConfig, {
        credential: new DefaultAzureCredential(),
      }),
      {
        // Cloud browsers have network latency to the local server. Loosen
        // the per-test and per-expect timeouts so flaky timeout failures
        // from round-trip delay don't mask real regressions.
        timeout: 120_000,
        expect: { timeout: 30_000 },
        reporter: [
          ['html', { open: 'never' }],
          ['@azure/playwright/reporter'],
        ],
      },
    )
  : baseConfig
