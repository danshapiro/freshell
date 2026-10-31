// @vitest-environment node
//
// Real Antigravity CLI launch smoke test.
//
// - "launches the real agy binary" always runs when `agy` (or the
//   `ANTIGRAVITY_CMD` override) is available — it skips with a clear reason
//   otherwise, never fails. This is the "actually launch the real CLI" proof:
//   it spawns the binary and asserts the version shape the Task 1 real-binary
//   probe recorded (`agy --version` prints a bare semver, e.g. `1.4.10`).
// - "completes a headless turn" is opt-in: it makes a real model call and is
//   DOUBLE-gated by FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 AND a Google API
//   key in the env. It skips (never fails) otherwise, and never runs in the
//   default suite — the whole test/integration/real/ tree is excluded from the
//   default config without the opt-in.
//
//   To run the full turn (CLI settings precondition: the real CLI's settings
//   must select API-key auth — `modelProvider: "gemini"` — per the plan's
//   Provider Contract Record, or the first paid attempt fails on CLI setup
//   rather than a contract fact):
//     FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 GEMINI_API_KEY=... \
//       pnpm run test:vitest run test/integration/real/antigravity-launch-smoke.test.ts \
//       --config config/vitest/vitest.config.ts
//
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { describe, it, expect } from 'vitest'

const execFileAsync = promisify(execFile)

// Provider contract (plan docs/plans/2026-10-29-google-cli-first-class-support.md,
// Provider Contract Record): command `agy`, env override `ANTIGRAVITY_CMD`;
// `-p` is the short alias for `--print` (headless prompt).
const agyCommand = process.env.ANTIGRAVITY_CMD || 'agy'

async function agyAvailable(): Promise<boolean> {
  try {
    await execFileAsync(agyCommand, ['--version'], { timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

const available = await agyAvailable()
const realEnabled = process.env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS === '1'
const hasProviderKey = Boolean(process.env.GEMINI_API_KEY)

describe('antigravity real launch smoke', () => {
  const itIfAvailable = available
    ? it
    : it.skip
  itIfAvailable('launches the real agy binary (agy --version)', async () => {
    const { stdout } = await execFileAsync(agyCommand, ['--version'], { timeout: 20_000 })
    // The real binary prints a bare version ("1.4.10" — Task 1 probe,
    // contract-probe.md), not a product name, so assert that exact shape.
    expect(stdout.trim()).toMatch(/^\d+\.\d+(\.\d+)?/)
  }, 30_000)

  const runTurn = available && realEnabled && hasProviderKey
  const itTurn = runTurn
    ? it
    : it.skip
  itTurn('completes a headless turn and echoes the nonce', async () => {
    const { stdout } = await execFileAsync(
      agyCommand,
      ['-p', 'Reply with exactly: antigravity-smoke-ok'],
      { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
    )
    expect(stdout).toContain('antigravity-smoke-ok')
  }, 200_000)
})
