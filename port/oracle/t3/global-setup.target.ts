import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ensureFreshE2eBuild } from '../../../test/e2e-browser/global-setup.js'
import { externalTargetConfigured } from '../../../test/e2e-browser/helpers/external-target.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function findProjectRoot(): string {
  let dir = __dirname
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    dir = path.dirname(dir)
  }
  throw new Error('Could not find project root')
}

/**
 * T3-oracle globalSetup wrapper.
 *
 * - External target (FRESHELL_E2E_TARGET_URL) OR FRESHELL_E2E_SKIP_BUILD=1:
 *   skip the client/server build entirely. The target (the Rust port, or a
 *   prebuilt original) is already running / already built.
 * - Otherwise: build the ORIGINAL exactly like the shared e2e globalSetup, so a
 *   local baseline run is self-contained.
 *
 * The shared test/e2e-browser/global-setup.ts is deliberately left untouched.
 */
export default async function globalSetup(): Promise<void> {
  if (externalTargetConfigured()) {
    console.log(
      `[t3-oracle-setup] External target set (FRESHELL_E2E_TARGET_URL=${process.env.FRESHELL_E2E_TARGET_URL}). ` +
      'Skipping build; the specs will be pointed at the running server.',
    )
    return
  }
  if (process.env.FRESHELL_E2E_SKIP_BUILD) {
    console.log('[t3-oracle-setup] FRESHELL_E2E_SKIP_BUILD=1 — reusing the existing dist/ build.')
    return
  }
  console.log('[t3-oracle-setup] No external target — building the ORIGINAL client+server for a local baseline run.')
  ensureFreshE2eBuild(findProjectRoot())
}
