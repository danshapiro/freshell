import { describe, expect, it } from 'vitest'
import { parseVerificationArgs, verificationSteps, playwrightFailure, verificationOutcome, playwrightReportEnvironment } from '../../../../scripts/testing/runtime-verify.js'

describe('direct runtime verification', () => {
  it('keeps every implemented terminal provider and fresh mode in the live matrix', () => {
    const steps = verificationSteps({ suite: 'live' })
    const env = Object.assign({}, ...steps.map(step => step.env))
    expect(env.FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_PROVIDERS).toBe('claude,codex,opencode,amplifier')
    expect(env.FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_MODES).toBe('freshclaude,kilroy,freshcodex,freshopencode')
    expect(steps.map(step => step.id)).toContain('opencode-qualification')
    expect(steps.map(step => step.id)).toContain('loss-notice')
  })
  it('separates provider tests, deterministic regressions, and long stress work', () => {
    expect(verificationSteps({ suite: 'deterministic' }).every(s => s.lane === 'deterministic')).toBe(true)
    expect(verificationSteps({ suite: 'stress' }).map(s => s.id)).toEqual(['chaos', 'soak'])
    expect(verificationSteps({ suite: 'all' }).length).toBeGreaterThan(verificationSteps({ suite: 'live' }).length)
  })
  it('accepts exact selections and rejects typos and duplicate steps', () => {
    expect(parseVerificationArgs(['--suite', 'live'])).toEqual({ suite: 'live' })
    expect(parseVerificationArgs(['--only', 'rehydrate'])).toEqual({ only: ['rehydrate'] })
    for (const args of [['--suite', 'typo'], ['--only'], ['--only', 'typo'], ['--only', 'rehydrate', 'rehydrate'], ['--suite', 'live', '--only', 'chaos']]) {
      expect(() => parseVerificationArgs(args)).toThrow()
    }
  })
  it('never mistakes an empty, skipped, flaky, or failed Playwright selection for coverage', () => {
    expect(playwrightFailure({ stats: { expected: 2, unexpected: 0, skipped: 0, flaky: 0 } })).toBeNull()
    for (const report of [undefined, {}, { stats: { expected: 0, unexpected: 0, skipped: 0, flaky: 0 } }, { stats: { expected: 2, unexpected: 0, skipped: 1, flaky: 0 } }, { stats: { expected: 2, unexpected: 0, skipped: 0, flaky: 1 } }, { stats: { expected: 2, unexpected: 1, skipped: 0, flaky: 0 } }]) {
      expect(playwrightFailure(report)).not.toBeNull()
    }
  })
  it('reports only the selected work and has no separate release-approval result', () => {
    expect(verificationOutcome(['PASS', 'PASS'])).toEqual({ status: 'PASS', exitCode: 0 })
    expect(verificationOutcome(['PASS', 'BLOCKED'])).toEqual({ status: 'BLOCKED', exitCode: 2 })
    expect(verificationOutcome(['FAIL', 'BLOCKED'])).toEqual({ status: 'FAIL', exitCode: 1 })
    expect(verificationOutcome([]).status).not.toBe('PASS')
  })
})


describe('Stage 5a local Docker browser execution', () => {
  it('uses the explicit local browser entrypoint and an exact JSON result path regardless of ambient cloud configuration', () => {
    const browserSteps = verificationSteps({ suite: 'all' }).filter(step => step.browser)
    expect(browserSteps.length).toBeGreaterThan(0)
    expect(playwrightReportEnvironment('/tmp/result.json')).toEqual({ PLAYWRIGHT_JSON_OUTPUT_FILE: '/tmp/result.json' })
    for (const step of browserSteps) {
      expect(step.args.slice(0, 2)).toEqual(['run', 'test:e2e:local'])
      expect(step.env.FRESHELL_E2E_BACKEND).toBe('local')
    }
  })
})
