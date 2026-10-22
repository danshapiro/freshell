// Simulator conformance: every scenario of claude-cli-scenarios.mjs runs on
// the real pinned CLI (against the loopback provider) and on the CLI
// simulator (test/fixtures/claude-cli-sim/query.mjs), and the two normalized
// traces must be equal. The simulator is only valid while this suite is
// green; a new behavior the design relies on gets a scenario here first.
//
// The suite runs inside claude-cli-contract.test.ts, on that file's real-CLI
// traces: the real scenarios are the expensive part (the heartbeat alone
// waits 30 s for the CLI), so each one runs once per test run and serves both
// the named facts and this comparison.

import { describe, expect, it } from 'vitest'
import { normalize } from './claude-cli-normalize'
import { eventsOf, scenarioCache, type ScenarioResult } from './claude-cli-trace'
import { SCENARIO_NAMES } from './claude-cli-scenarios.mjs'

// The real CLI's tool heartbeat is a fixed 30 s; the simulator runs that
// scenario on a compressed clock (its reported elapsed seconds stay virtual).
const COMPRESSED = { FRESHELL_CLAUDE_SIM_TIME_SCALE: '0.05' }
const TIMEOUT = 160_000

/** The conformance suite, comparing the simulator against `real`'s traces. */
export function describeSimulatorConformance(real: (scenario: string) => Promise<ScenarioResult>) {
  const sim = scenarioCache('sim', { heartbeat: { env: COMPRESSED } })

  describe('Claude CLI simulator conformance (normalized traces, sim vs the pinned real CLI)', () => {
    for (const scenario of SCENARIO_NAMES) {
      it(`${scenario}: the simulator's normalized trace equals the real CLI's`, async () => {
        const [expected, actual] = await Promise.all([real(scenario), sim(scenario)])
        expect(normalize(actual)).toEqual(normalize(expected))
      }, TIMEOUT)
    }

    it('cold-stop with the simulator\'s queued-receipt knob keeps the real outcome and lists the command as still queued', async () => {
      const [expected, actual] = await Promise.all([
        real('cold-stop'),
        scenarioCache('sim', { 'cold-stop': { env: { FRESHELL_CLAUDE_SIM_COLD_STOP_RECEIPT: 'queued' } } })('cold-stop'),
      ])
      expect(normalize(actual)).toEqual(normalize(expected))
      const receipts = (session: string) => eventsOf(actual, session).filter((e) => e.k === 'interrupt-settled' && e.tag === 'cold').map((e) => e.receipt)
      expect(receipts('noResend')).toEqual([{ still_queued: ['u1'] }])
      expect(receipts('resend')).toEqual([{ still_queued: ['u2'] }])
    }, TIMEOUT)
  })
}
