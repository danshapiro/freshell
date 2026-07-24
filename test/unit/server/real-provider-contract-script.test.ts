import { describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'

// The real-provider contract tests under test/integration/real/ gate on
// process.env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS === '1' (see AGENTS.md and
// each test header). A launcher script that sets any other variable name is a
// silent no-op: every gated test skips and the "contract" never actually runs.
// (Distinct from FRESHELL_REAL_PROVIDER_CONTRACTS, which vite-config.test.ts
// uses for an unrelated purpose — do not conflate them.)
describe('real-provider coding-cli contract launcher script', () => {
  it('enables the opt-in via the exact env var the gated tests check', async () => {
    const root = process.cwd()
    const packageJson = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const script = packageJson.scripts?.['test:real:coding-cli-contracts'] ?? ''

    // Must set the gate the tests actually read...
    expect(script).toContain('FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1')
    // ...and must NOT reintroduce the historical typo that made it a no-op.
    expect(script).not.toContain('FRESHELL_REAL_PROVIDER_CONTRACTS=1')
    // ...while still targeting the real contract suite.
    expect(script).toContain('test/integration/real/coding-cli-session-contract.test.ts')
  })

  it('stays consistent with the env gate asserted by the contract test', async () => {
    const root = process.cwd()
    const testFile = await fsp.readFile(
      path.join(root, 'test/integration/real/coding-cli-session-contract.test.ts'),
      'utf8',
    )
    expect(testFile).toContain("process.env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS === '1'")
  })
})
