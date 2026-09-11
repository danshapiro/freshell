import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeHarness } from '../../../../scripts/testing/runtime-sandbox.js'

const root = path.resolve(__dirname, '../../../..')
afterEach(() => vi.unstubAllEnvs())

describe('unit tests nested in a runtime scenario', () => {
  it('keeps the outer coordinator lease and uses a repo-owned focused child invocation', () => {
    vi.stubEnv('FRESHELL_TEST_COORDINATOR_ACTIVE', '1')
    const harness = new RuntimeHarness(root)
    const run = vi.spyOn(harness, 'runCommand').mockReturnValue('Tests\u001b[32m 3 passed\u001b[0m')
    harness.runFocusedVitest('test/unit/client/components/ManagedRuntimeNotices.test.tsx')
    expect(run).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['npm', 'run', 'test:vitest']), {
      env: { FRESHELL_TEST_COORDINATOR_ACTIVE: undefined },
    })
    expect(process.env.FRESHELL_TEST_COORDINATOR_ACTIVE).toBe('1')
  })
  it('rejects broad or invalid selectors and zero passing tests', () => {
    const harness = new RuntimeHarness(root)
    const run = vi.spyOn(harness, 'runCommand').mockReturnValue('Tests 0 passed')
    for (const selector of ['', 'test/unit', 'test/**/*.test.ts', '../test/unit/client/nope.test.ts']) {
      expect(() => harness.runFocusedVitest(selector)).toThrow()
    }
    expect(run).not.toHaveBeenCalled()
    expect(() => harness.runFocusedVitest('test/unit/client/components/ManagedRuntimeNotices.test.tsx')).toThrow(/no passing tests/)
  })
})
