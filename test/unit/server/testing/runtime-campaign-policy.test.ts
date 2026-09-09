import { describe, expect, it } from 'vitest'

import {
  buildReceiptEnvironment,
  defineCampaignProducerStep,
  deriveProductionGateExpectation,
  parseCampaignArguments,
  parseRuntimeGateLink,
  resolveCampaignOutcome,
  validateGateSummary,
  validateProducerEvidence,
  type CampaignStepDescriptor,
} from '../../../../scripts/testing/runtime-campaign-policy.js'

const steps: CampaignStepDescriptor[] = [
  { id: 'producer', kind: 'producer', produces: ['RECEIPT_A'] },
  { id: 'other-producer', kind: 'producer', produces: ['RECEIPT_B'] },
  { id: 'landing-gate', kind: 'gate', produces: [] },
]

describe('runtime campaign CLI policy', () => {
  it('provides a strict registration seam for per-provider producers', () => {
    expect(defineCampaignProducerStep({
      id: 'claude-qualification',
      kind: 'producer',
      title: 'Claude qualification',
      produces: ['FRESHELL_RUNTIME_CLAUDE_RECEIPT'],
      provider: 'claude',
    })).toMatchObject({ id: 'claude-qualification', provider: 'claude' })
    expect(() => defineCampaignProducerStep({
      id: 'claude-qualification',
      kind: 'producer',
      title: 'Claude qualification',
      produces: [],
    })).toThrow(/receipt/)
  })

  it('selects the full default campaign only when --only is absent', () => {
    expect(parseCampaignArguments([], steps)).toEqual({ list: false, allowDirty: false, only: null })
    expect(parseCampaignArguments(['--only', 'landing-gate'], steps)).toEqual({
      list: false,
      allowDirty: false,
      only: ['landing-gate'],
    })
  })

  it.each([
    ['--only'],
    ['--only', 'unknown'],
    ['--only', 'producer', 'producer'],
    ['--only', 'producer', '--only', 'landing-gate'],
    ['--allow-dirty', '--allow-dirty'],
    ['--list', '--allow-dirty'],
    ['--wat'],
    ['producer'],
  ])('rejects empty, unknown, duplicate, or ambiguous arguments: %j', (...args) => {
    expect(() => parseCampaignArguments(args, steps)).toThrow()
  })
})

describe('runtime campaign receipt provenance', () => {
  it('builds the full receipt environment for a gate-only rerun from prior receipts', () => {
    expect(buildReceiptEnvironment({
      steps,
      currentTargets: {},
      priorReceipts: {
        RECEIPT_A: '/evidence/prior/a.json',
        RECEIPT_B: '/evidence/prior/b.json',
      },
      unresolvedRoot: '/evidence/current/unproduced',
    })).toEqual({
      RECEIPT_A: '/evidence/prior/a.json',
      RECEIPT_B: '/evidence/prior/b.json',
    })
  })

  it('uses an isolated current producer target without dropping other catalogue entries', () => {
    expect(buildReceiptEnvironment({
      steps,
      currentTargets: { RECEIPT_A: '/evidence/current/producer/a.json' },
      priorReceipts: { RECEIPT_A: '/evidence/prior/a.json', RECEIPT_B: '/evidence/prior/b.json' },
      unresolvedRoot: '/evidence/current/unproduced',
    })).toEqual({
      RECEIPT_A: '/evidence/current/producer/a.json',
      RECEIPT_B: '/evidence/prior/b.json',
    })
  })

  it('fails a producer that skipped, ran zero tests, omitted a receipt, reused a target, or wrote stale evidence', () => {
    const base = {
      candidateSha: 'a'.repeat(40),
      runner: 'playwright' as const,
      log: '1 passed (1s)',
      receipts: [{
        envName: 'RECEIPT_A',
        before: { exists: false },
        after: {
          exists: true,
          regularFile: true,
          symbolicLink: false,
          digestSha256: 'd'.repeat(64),
          value: { status: 'PASS', candidateSha: 'a'.repeat(40) },
        },
      }],
    }
    expect(validateProducerEvidence(base)).toEqual([])
    expect(validateProducerEvidence({ ...base, log: '1 skipped' })).toContain('Playwright ran zero passing tests')
    expect(validateProducerEvidence({ ...base, log: '1 passed\n1 skipped' })).toContain('Playwright reported skipped tests')
    expect(validateProducerEvidence({ ...base, receipts: [{ ...base.receipts[0], after: { exists: false } }] })).toContain('RECEIPT_A was not produced')
    expect(validateProducerEvidence({ ...base, receipts: [{ ...base.receipts[0], before: { exists: true } }] })).toContain('RECEIPT_A target existed before this step')
    expect(validateProducerEvidence({
      ...base,
      receipts: [{
        ...base.receipts[0],
        after: { ...base.receipts[0].after, value: { status: 'PASS', candidateSha: 'b'.repeat(40) } },
      }],
    })).toContain('RECEIPT_A belongs to a different candidate')
  })
})

describe('runtime campaign gate correlation', () => {
  it('accepts exact UUID linking and rejects malformed or partial provenance', () => {
    const gateRunId = '2a7067d5-8af0-4acc-825c-0e6503b62f9c'
    const campaignRunId = 'b0c5c62c-e7fd-49ef-a56b-f9d92fdf43c0'
    expect(parseRuntimeGateLink({ gateRunId, campaignRunId, campaignStepId: 'landing-gate' })).toEqual({
      gateRunId,
      campaign: { runId: campaignRunId, stepId: 'landing-gate' },
    })
    expect(() => parseRuntimeGateLink({ gateRunId: '../summary' })).toThrow(/UUID/)
    expect(() => parseRuntimeGateLink({ campaignRunId, campaignStepId: undefined })).toThrow(/provenance/)
    expect(() => parseRuntimeGateLink({ campaignRunId, campaignStepId: '../gate' })).toThrow(/provenance/)
  })

  const expectation = {
    gateId: 'durable-souls-landing',
    phase: 'phase-5',
    mode: 'landing',
    status: 'PASS' as const,
    blockedReason: null,
    exitCode: 0 as const,
  }
  const summary = {
    gate: expectation.gateId,
    phase: expectation.phase,
    mode: expectation.mode,
    status: expectation.status,
    blockedReason: null,
    candidateSha: 'a'.repeat(40),
    runId: 'gate-run',
    campaign: { runId: 'campaign-run', stepId: 'landing-gate' },
    failures: [],
    caseResults: [{ caseId: 'P1-G01', status: 'PASS' }],
    cleanup: { ok: true },
    unsafeDockerAttempts: [],
    candidateIntegrity: { failures: [] },
  }

  it('accepts exact gate identity, candidate, provenance, exit, cleanup, and outcome', () => {
    expect(validateGateSummary({
      summary,
      expectation,
      exitCode: 0,
      candidateSha: 'a'.repeat(40),
      gateRunId: 'gate-run',
      campaignRunId: 'campaign-run',
      stepId: 'landing-gate',
    })).toEqual([])
  })

  it.each([
    ['gate', { gate: 'another-gate' }],
    ['candidate', { candidateSha: 'b'.repeat(40) }],
    ['run', { runId: 'concurrent-run' }],
    ['provenance', { campaign: { runId: 'other', stepId: 'landing-gate' } }],
    ['mode', { mode: 'production' }],
    ['cleanup', { cleanup: { ok: false } }],
    ['unsafe attempts', { unsafeDockerAttempts: [{}] }],
    ['failures', { failures: ['hidden failure'] }],
  ])('rejects mismatched %s even if status says PASS', (_label, change) => {
    expect(validateGateSummary({
      summary: { ...summary, ...change },
      expectation,
      exitCode: 0,
      candidateSha: 'a'.repeat(40),
      gateRunId: 'gate-run',
      campaignRunId: 'campaign-run',
      stepId: 'landing-gate',
    }).length).toBeGreaterThan(0)
  })

  it('rejects a status/exit mismatch', () => {
    expect(validateGateSummary({
      summary,
      expectation,
      exitCode: 2,
      candidateSha: 'a'.repeat(40),
      gateRunId: 'gate-run',
      campaignRunId: 'campaign-run',
      stepId: 'landing-gate',
    })).toContain('gate exit code 2 did not match expected 0')
  })

  it('derives production PASS after certification instead of expecting BLOCKED forever', () => {
    expect(deriveProductionGateExpectation({
      gateId: 'production',
      eligible: false,
      blockedReason: 'pending_live_provider_certification',
    })).toMatchObject({ status: 'BLOCKED', exitCode: 2 })
    expect(deriveProductionGateExpectation({
      gateId: 'production',
      eligible: true,
      blockedReason: null,
    })).toEqual({
      gateId: 'production',
      phase: 'phase-5',
      mode: 'production',
      status: 'PASS',
      blockedReason: null,
      exitCode: 0,
    })
  })
})

describe('runtime campaign final classification', () => {
  it('labels a clean successful --only run PARTIAL rather than production approval', () => {
    expect(resolveCampaignOutcome({ full: false, dirtyRehearsal: false, stepsOk: true, candidateOk: true }))
      .toEqual({ status: 'PARTIAL', exitCode: 0, qualifying: false, productionApproval: false })
  })

  it('keeps --allow-dirty rehearsals typed BLOCKED even when every selected step succeeds', () => {
    expect(resolveCampaignOutcome({ full: true, dirtyRehearsal: true, stepsOk: true, candidateOk: false }))
      .toEqual({ status: 'BLOCKED', exitCode: 2, qualifying: false, productionApproval: false })
  })

  it('permits final PASS only for a clean, complete, stable candidate', () => {
    expect(resolveCampaignOutcome({
      full: true,
      dirtyRehearsal: false,
      stepsOk: true,
      candidateOk: true,
      productionGatePassed: true,
    }))
      .toEqual({ status: 'PASS', exitCode: 0, qualifying: true, productionApproval: true })
    expect(resolveCampaignOutcome({ full: true, dirtyRehearsal: false, stepsOk: false, candidateOk: true }).status)
      .toBe('FAIL')
  })

  it('does not call a successful pre-certification campaign production approval', () => {
    expect(resolveCampaignOutcome({
      full: true,
      dirtyRehearsal: false,
      stepsOk: true,
      candidateOk: true,
      productionGatePassed: false,
    })).toMatchObject({ status: 'PASS', qualifying: true, productionApproval: false })
  })
})
