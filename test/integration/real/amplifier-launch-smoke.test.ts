// @vitest-environment node
//
// Real Amplifier launch smoke test.
//
// - "launches the real amplifier binary" always runs when `amplifier` is on PATH
//   (skips with a clear reason otherwise). This is the "actually launch amplifier"
//   proof: it spawns the real binary and asserts it reports its version.
// - "completes a headless turn" is opt-in: it makes a real LLM call and is gated by
//   FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 AND a provider key in the env. It skips
//   (never fails) otherwise.
//
//   To run the full turn:
//     FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 ANTHROPIC_API_KEY=... \
//       npm run test:vitest -- run test/integration/real/amplifier-launch-smoke.test.ts \
//       --config config/vitest/vitest.server.config.ts
//
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { describe, it, expect } from 'vitest'

const execFileAsync = promisify(execFile)

async function amplifierOnPath(): Promise<boolean> {
  try {
    await execFileAsync('amplifier', ['--version'], { timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

const onPath = await amplifierOnPath()
const realEnabled = process.env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS === '1'
const hasProviderKey = Boolean(
  process.env.ANTHROPIC_API_KEY
  || process.env.OPENAI_API_KEY
  || process.env.AZURE_OPENAI_API_KEY
  || process.env.GOOGLE_API_KEY,
)

describe('amplifier real launch smoke', () => {
  const itIfOnPath = onPath
    ? it
    : it.skip
  itIfOnPath('launches the real amplifier binary (amplifier --version)', async () => {
    const { stdout } = await execFileAsync('amplifier', ['--version'], { timeout: 20_000 })
    expect(stdout.toLowerCase()).toContain('amplifier')
  }, 30_000)

  const runTurn = onPath && realEnabled && hasProviderKey
  const itTurn = runTurn
    ? it
    : it.skip
  itTurn('completes a headless turn and returns a success envelope', async () => {
    const { stdout } = await execFileAsync(
      'amplifier',
      ['run', '--output-format', 'json', 'Reply with exactly: amplifier-smoke-ok'],
      { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
    )
    const envelope = JSON.parse(stdout)
    expect(envelope.status).toBe('success')
    expect(typeof envelope.response).toBe('string')
  }, 200_000)
})
