import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  capabilityClaimViolations,
  certifiedDurableProviders,
  deferredProviders,
  classifyProviderCertificationCase,
  DEFERRED_CASE_STATUS,
  loadCapabilityManifest,
  PENDING_LIVE_PROVIDER_CERTIFICATION,
  productionCertificationStatus,
  providerCertificationCaseId,
  resolveGateOutcome,
  type GateOutcomeInput,
} from '../../../../scripts/testing/provider-certification.js'
import { parseGateArgs } from '../../../../scripts/testing/runtime-gate-args.js'

const repoRoot = path.resolve(__dirname, '../../../..')

function outcome(overrides: Partial<GateOutcomeInput> & { expectedCaseIds?: string[] } = {}) {
  return resolveGateOutcome({
    mode: 'landing',
    caseResults: [{ caseId: 'P1-G01', status: 'PASS' }],
    cleanupOk: true,
    unsafeBrokerAttempts: 0,
    deferred: [],
    deferrableProviders: ['claude', 'codex', 'amplifier'],
    ...overrides,
  })
}

describe('release qualification cannot pass by omission', () => {
  it('rejects an empty campaign', () => {
    expect(outcome({ caseResults: [] }).status).toBe('FAIL')
  })

  it('rejects duplicate case results even when both say PASS', () => {
    expect(outcome({ caseResults: [
      { caseId: 'P1-G01', status: 'PASS' },
      { caseId: 'P1-G01', status: 'PASS' },
    ] }).status).toBe('FAIL')
  })

  it('requires every declared case and rejects undeclared cases', () => {
    expect(outcome({ expectedCaseIds: ['P1-G01', 'P1-G02'] }).status).toBe('FAIL')
    expect(outcome({ expectedCaseIds: ['P1-G02'] }).status).toBe('FAIL')
    expect(outcome({ expectedCaseIds: ['P1-G01'] }).status).toBe('PASS')
  })

  it('rejects duplicate or empty required case sets', () => {
    expect(outcome({ expectedCaseIds: [] }).status).toBe('FAIL')
    expect(outcome({ expectedCaseIds: ['P1-G01', 'P1-G01'] }).status).toBe('FAIL')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5])(
    'rejects an invalid unsafe-attempt count %s rather than treating it as zero',
    (unsafeBrokerAttempts) => {
      expect(outcome({ unsafeBrokerAttempts }).status).toBe('FAIL')
    },
  )

  it('requires literal verified cleanup rather than a truthy malformed result', () => {
    expect(outcome({ cleanupOk: 'yes' as unknown as boolean }).status).toBe('FAIL')
  })

  it('never defers a phase case by omitting the provider field', () => {
    expect(outcome({ caseResults: [{ caseId: 'P5-G10', status: DEFERRED_CASE_STATUS }] }).status).toBe('FAIL')
  })

  it('never defers a phase case by borrowing an allowed provider name', () => {
    expect(outcome({
      caseResults: [{ caseId: 'P5-G10', status: DEFERRED_CASE_STATUS, provider: 'claude' }],
      deferred: ['claude'],
    }).status).toBe('FAIL')
  })

  it('rejects provider identity mismatch on a certification deferral', () => {
    expect(outcome({
      caseResults: [{ caseId: 'PC-OPENCODE', status: DEFERRED_CASE_STATUS, provider: 'claude' }],
      deferred: ['claude'],
    }).status).toBe('FAIL')
  })

  it('requires the deferred-provider list to account for each deferred result', () => {
    expect(outcome({
      caseResults: [{ caseId: 'PC-CLAUDE', status: DEFERRED_CASE_STATUS, provider: 'claude' }],
    }).status).toBe('FAIL')
    expect(outcome({ deferred: ['claude'] }).status).toBe('FAIL')
  })

  it('does not let a production deferred list hide behind all-PASS results', () => {
    expect(outcome({ mode: 'production', deferred: ['claude'] }).status).toBe('FAIL')
  })

  it('preserves typed BLOCKED for an explicitly recorded production prerequisite', () => {
    expect(outcome({
      mode: 'production',
      caseResults: [{ caseId: 'PC-CLAUDE', status: 'BLOCKED', reason: PENDING_LIVE_PROVIDER_CERTIFICATION, provider: 'claude' }],
      deferred: ['claude'],
    })).toMatchObject({ status: 'BLOCKED', exitCode: 2, blockedReason: PENDING_LIVE_PROVIDER_CERTIFICATION })
  })

  it('keeps authorized landing deferral compatible with inferred certification identity', () => {
    expect(outcome({
      caseResults: [{ caseId: 'PC-CLAUDE', status: DEFERRED_CASE_STATUS }],
      deferred: ['claude'],
    }).status).toBe('PASS')
  })

  it('rejects duplicate deferred-provider bookkeeping', () => {
    expect(outcome({
      caseResults: [{ caseId: 'PC-CLAUDE', status: DEFERRED_CASE_STATUS, provider: 'claude' }],
      deferred: ['claude', 'claude'],
    }).status).toBe('FAIL')
  })
})

describe('release-scope audit covers the advertised provider set', () => {
  it('rejects an uncertified provider named only in the managed release scope', () => {
    const manifest = loadCapabilityManifest(repoRoot)
    manifest.releaseScope!.managedTerminalProviders!.push('kimi')
    expect(capabilityClaimViolations(manifest).join(' ')).toMatch(/releaseScope.*kimi|kimi.*releaseScope/)
  })

  it('rejects an unknown provider at a managed doorway', () => {
    const manifest = loadCapabilityManifest(repoRoot)
    manifest.doorways.find((row) => row.policy === 'managed')!.providers.push('unknown-provider')
    expect(capabilityClaimViolations(manifest).join(' ')).toContain('unknown-provider')
  })

  it('rejects duplicate provider declarations instead of silently picking one', () => {
    const manifest = loadCapabilityManifest(repoRoot)
    manifest.providers.push({ ...manifest.providers.find((row) => row.provider === 'opencode')! })
    // Keep the old derived-list audit satisfied: uniqueness is independently required.
    manifest.certification.certifiedDurableProviders.push('opencode')
    expect(capabilityClaimViolations(manifest).join(' ')).toMatch(/duplicate.*opencode|opencode.*duplicate/)
  })

  it('rejects an empty production certification requirement', () => {
    const manifest = loadCapabilityManifest(repoRoot)
    manifest.certification.productionGate.requiredCertifiedProviders = []
    expect(capabilityClaimViolations(manifest).join(' ')).toMatch(/requiredCertifiedProviders/)
  })

  it.each(['shell', 'opencode'])('rejects removing advertised managed provider %s from production requirements', (provider) => {
    const manifest = loadCapabilityManifest(repoRoot)
    expect(capabilityClaimViolations(manifest)).toEqual([])
    manifest.certification.productionGate.requiredCertifiedProviders =
      manifest.certification.productionGate.requiredCertifiedProviders.filter((required) => required !== provider)
    expect(capabilityClaimViolations(manifest)).toContain(`requiredCertifiedProviders omits managed provider ${provider}`)
  })

  it.each(['claude', 'codex', 'amplifier'])('allows disabled pending provider %s to remain omitted without claiming release or PASS', (provider) => {
    const manifest = loadCapabilityManifest(repoRoot)
    const pending = manifest.providers.find(row => row.provider === provider)!
    Object.assign(pending, { certificationState: PENDING_LIVE_PROVIDER_CERTIFICATION,
      managedEnabled: false, durableRecoveryEnabled: false, blockedReason: 'PENDING_LIVE_QUALIFICATION' })
    manifest.certification.deferredProviders = deferredProviders(manifest)
    manifest.certification.landingGate.deferrableProviders = deferredProviders(manifest)
    manifest.certification.certifiedDurableProviders = certifiedDurableProviders(manifest)
    manifest.releaseScope!.managedTerminalProviders = manifest.releaseScope!.managedTerminalProviders!
      .filter(name => name !== provider)
    for (const row of manifest.freshAgentModes) if (row.provider === provider) {
      Object.assign(row, { enabledInReleaseScope: false, certified: false,
        liveQualificationStatus: 'pending_authentic_receipt', releaseDeferralReason: PENDING_LIVE_PROVIDER_CERTIFICATION })
      Object.assign(manifest.doorways.find(doorway => doorway.id === `rest-${row.mode}-create`)!,
        { policy: 'blocked', enabledInReleaseScope: false })
    }
    manifest.releaseScope!.disabledFreshAgentModes = manifest.freshAgentModes
      .filter(row => !row.enabledInReleaseScope).map(row => row.mode)
    for (const doorway of manifest.doorways) if (doorway.policy === 'managed') {
      doorway.providers = doorway.providers.filter(name => name !== provider)
    }
    manifest.certification.productionGate.requiredCertifiedProviders = manifest.providers
      .filter(row => row.managedEnabled).map(row => row.provider)
    expect(capabilityClaimViolations(manifest)).toEqual([])
    expect(productionCertificationStatus(manifest).status).toBe('ELIGIBLE')
    const row = manifest.providers.find((candidate) => candidate.provider === provider)!
    const classification = classifyProviderCertificationCase('production', row)
    expect(classification).toEqual({ status: 'BLOCKED', reason: PENDING_LIVE_PROVIDER_CERTIFICATION })
    expect(outcome({ mode: 'production', caseResults: [{
      caseId: providerCertificationCaseId(provider), provider,
      status: classification.status, reason: classification.reason!,
    }] })).toMatchObject({ status: 'BLOCKED', exitCode: 2 })
    manifest.releaseScope!.managedTerminalProviders!.push(provider)
    expect(capabilityClaimViolations(manifest)).toContain(
      `releaseScope.managedTerminalProviders includes unknown or uncertified provider ${provider}`,
    )
  })

  it('rejects unknown or duplicate required providers', () => {
    const manifest = loadCapabilityManifest(repoRoot)
    manifest.certification.productionGate.requiredCertifiedProviders.push('unknown-provider', 'opencode')
    const violations = capabilityClaimViolations(manifest).join(' ')
    expect(violations).toContain('unknown-provider')
    expect(violations).toMatch(/duplicate.*opencode|opencode.*duplicate/)
  })

  it('does not accept a certified provider as a deferrable landing provider', () => {
    const manifest = loadCapabilityManifest(repoRoot)
    manifest.certification.landingGate.deferrableProviders.push('opencode')
    expect(capabilityClaimViolations(manifest).join(' ')).toMatch(/deferrableProviders.*opencode|opencode.*deferrableProviders/)
  })
})

describe('release gate CLI refuses ambiguous or misspelled options', () => {
  it.each([
    ['gate', 'phase-5', '--require-live', '--mode', 'landing', '--mode', 'production'],
    ['gate', 'phase-5', '--require-live', '--mode', 'landing', '--mod', 'production'],
    ['gate', 'phase-5', '--require-live', '--allow-dirty'],
    ['gate', 'phase-5', '--require-live', 'ignored-extra-target'],
    ['gate', 'phase-5', '--require-live', '--require-live'],
  ])('rejects %j', (...args) => {
    expect(parseGateArgs(args)).toMatchObject({ exitCode: 1 })
  })
})
