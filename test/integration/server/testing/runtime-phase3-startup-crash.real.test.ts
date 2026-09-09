import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { RuntimeHarness } from '../../../../scripts/testing/runtime-sandbox.js'
import { exercisePhase3StartupReplacementCrash } from '../../../runtime/gates/phase-3.test.js'

const runRealSmoke = process.env.FRESHELL_RUNTIME_PHASE3_STARTUP_CRASH_SMOKE === '1'

describe.runIf(runRealSmoke)('Phase 3 startup-timed replacement crash fixture', () => {
  it('hits after_docker_create during startup reconciliation and safely converges', async () => {
    const repoRoot = path.resolve(__dirname, '../../../..')
    const harness = new RuntimeHarness(repoRoot, undefined, 3)
    let cleanup: { ok: boolean; errors: string[] } = { ok: false, errors: ['cleanup not attempted'] }
    try {
      await harness.prepare()
      const proof = await exercisePhase3StartupReplacementCrash(harness)
      expect(proof.crashEvent).toEqual({
        event: 'supervisor.test_crash',
        point: 'after_docker_create',
      })
      expect(proof.recoveryOutcome).toMatch(/^(replaced|reattached)$/)
      expect(proof.nativeSessionStable).toBe(true)
      expect(proof.stopOutcome).toBe('verified_empty')
    } finally {
      cleanup = await harness.cleanup()
    }
    expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
  }, 240_000)
})
