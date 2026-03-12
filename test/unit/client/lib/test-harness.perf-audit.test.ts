import { describe, expect, it } from 'vitest'
import { createPerfAuditBridge } from '@/lib/perf-audit-bridge'
import { installTestHarness } from '@/lib/test-harness'

function installHarnessForTest() {
  const bridge = createPerfAuditBridge()
  bridge.mark('app.bootstrap_started')

  installTestHarness(
    {
      getState: () => ({ ok: true }),
      dispatch: (() => undefined) as never,
    } as never,
    () => 'ready',
    async () => undefined,
    () => undefined,
    () => undefined,
    () => bridge.snapshot(),
  )

  return window.__FRESHELL_TEST_HARNESS__!
}

describe('test harness perf audit helpers', () => {
  it('exposes a perf audit snapshot when installed', async () => {
    const harness = installHarnessForTest()
    expect(harness.getPerfAuditSnapshot()?.milestones).toBeDefined()
  })
})
