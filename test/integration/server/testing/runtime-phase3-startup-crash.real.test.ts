import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { RuntimeHarness } from '../../../../scripts/testing/runtime-sandbox.js'
import { exercisePhase3StartupReplacementCrash } from '../../../runtime/gates/phase-3.test.js'

const runRealSmoke = process.env.FRESHELL_RUNTIME_PHASE3_STARTUP_CRASH_SMOKE === '1'

describe.runIf(runRealSmoke)('Phase 3 startup-timed replacement crash fixture', () => {
  let harness: RuntimeHarness

  // Build and image preparation are prerequisites, not part of the fault's
  // bounded recovery window. Keeping them outside the test also guarantees
  // afterAll owns cleanup when a cold compilation exceeds an assertion budget.
  beforeAll(async () => {
    const repoRoot = path.resolve(__dirname, '../../../..')
    harness = new RuntimeHarness(repoRoot, undefined, 3)
    await harness.prepare()
  }, 900_000)

  afterAll(async () => {
    if (!harness) return
    const cleanup = await harness.cleanup()
    if (!cleanup.ok) throw new Error(cleanup.errors.join('\n'))
  }, 180_000)

  it('hits after_docker_create during startup reconciliation and safely converges', async () => {
    const proof = await exercisePhase3StartupReplacementCrash(harness)
    expect(proof.crashEvent).toEqual({
      event: 'supervisor.test_crash',
      point: 'after_docker_create',
    })
    expect(proof.recoveryOutcome).toMatch(/^(replaced|reattached)$/)
    expect(proof.nativeSessionStable).toBe(true)
    expect(proof.stopOutcome).toBe('verified_empty')
  }, 240_000)
})
