import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFERRED_CASE_STATUS,
  PENDING_LIVE_PROVIDER_CERTIFICATION,
  capabilityClaimViolations,
  certifiedDurableProviders,
  classifyProviderCertificationCase,
  deferredProviderManifest,
  deferredProviders,
  loadCapabilityManifest,
  productionCertificationStatus,
  providerCertificationCaseId,
  providerCertificationCaseIds,
  certificationCaseIds,
  RELEASE_SCOPE_CASE_ID,
  resolveGateOutcome,
} from '../../../../scripts/testing/provider-certification.js'
import { parseGateArgs } from '../../../../scripts/testing/runtime-gate-args.js'

const repoRoot = path.resolve(__dirname, '../../../..')

const tempRoots: string[] = []
afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

function manifestFixture(overrides: Record<string, unknown>[] = []): any {
  const base = loadCapabilityManifest(repoRoot)
  if (!overrides.length) return base
  const clone = JSON.parse(JSON.stringify(base))
  for (const override of overrides) {
    const row = clone.providers.find((entry: any) => entry.provider === override.provider)
    Object.assign(row, override)
  }
  return clone
}

describe('checked-in provider certification manifest', () => {
  it('marks exactly Claude, Codex, and Amplifier as pending live certification', () => {
    const manifest = loadCapabilityManifest(repoRoot)
    expect(deferredProviders(manifest)).toEqual(['claude', 'codex', 'amplifier'])
    expect(certifiedDurableProviders(manifest)).toEqual(['opencode'])
  })

  it('publishes a typed deferred-provider manifest with the live gate for each', () => {
    const rows = deferredProviderManifest(loadCapabilityManifest(repoRoot))
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.reason).toBe(PENDING_LIVE_PROVIDER_CERTIFICATION)
      expect(row.managedEnabled).toBe(false)
      expect(row.durableRecoveryEnabled).toBe(false)
      expect(row.liveGate).toBeTruthy()
      expect(row.caseId).toBe(providerCertificationCaseId(row.provider))
    }
  })

  it('has no durable-souls claim for an uncertified provider', () => {
    expect(capabilityClaimViolations(loadCapabilityManifest(repoRoot))).toEqual([])
  })

  it('reports a violation when a deferred provider is silently promoted', () => {
    const violations = capabilityClaimViolations(
      manifestFixture([{ provider: 'claude', managedEnabled: true, durableRecoveryEnabled: true }]),
    )
    expect(violations.join(' ')).toContain('claude')
  })

  it('reports a violation when a managed doorway routes an uncertified provider', () => {
    const manifest = manifestFixture()
    manifest.doorways.find((row: any) => row.id === 'deferred-managed-provider-create').policy = 'managed'
    expect(capabilityClaimViolations(manifest).join(' ')).toContain('deferred-managed-provider-create')
  })

  it('enumerates one certification case per managed-or-deferred provider', () => {
    expect(providerCertificationCaseIds(loadCapabilityManifest(repoRoot))).toEqual([
      'PC-SHELL', 'PC-CLAUDE', 'PC-OPENCODE', 'PC-CODEX', 'PC-AMPLIFIER',
    ])
  })

  it('puts the release-scope audit first in the full certification case set', () => {
    expect(certificationCaseIds(loadCapabilityManifest(repoRoot))).toEqual([
      RELEASE_SCOPE_CASE_ID, 'PC-SHELL', 'PC-CLAUDE', 'PC-OPENCODE', 'PC-CODEX', 'PC-AMPLIFIER',
    ])
  })

  it('matches the case ids the gate manifest declares', () => {
    const gateManifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'test/runtime/gate-manifest.json'), 'utf8'),
    )
    expect(gateManifest.certification_gates.provider_certification_case_ids)
      .toEqual(certificationCaseIds(loadCapabilityManifest(repoRoot)))
  })
})

describe('production certification status', () => {
  it('is blocked, never pass, while any provider awaits live certification', () => {
    const status = productionCertificationStatus(loadCapabilityManifest(repoRoot))
    expect(status.status).toBe('BLOCKED_PENDING_LIVE_PROVIDER_CERTIFICATION')
    expect(status.reason).toBe(PENDING_LIVE_PROVIDER_CERTIFICATION)
    expect(status.blockingProviders).toEqual(['claude', 'codex', 'amplifier'])
  })

  it('becomes eligible only when every required provider is certified', () => {
    const manifest = manifestFixture([
      { provider: 'claude', certificationState: 'certified', managedEnabled: true, durableRecoveryEnabled: true, blockedReason: null },
      { provider: 'codex', certificationState: 'certified', managedEnabled: true, durableRecoveryEnabled: true, blockedReason: null },
      { provider: 'amplifier', certificationState: 'certified', managedEnabled: true, durableRecoveryEnabled: true, blockedReason: null },
    ])
    const status = productionCertificationStatus(manifest)
    expect(status.status).toBe('ELIGIBLE')
    expect(status.blockingProviders).toEqual([])
  })
})

describe('per-provider case classification', () => {
  const manifest = loadCapabilityManifest(repoRoot)
  const row = (provider: string) => manifest.providers.find((entry: any) => entry.provider === provider)

  it('defers an uncertified provider only in landing mode', () => {
    expect(classifyProviderCertificationCase('landing', row('claude')).status).toBe(DEFERRED_CASE_STATUS)
    expect(classifyProviderCertificationCase('production', row('claude')).status).toBe('BLOCKED')
    expect(classifyProviderCertificationCase('production', row('claude')).reason)
      .toBe(PENDING_LIVE_PROVIDER_CERTIFICATION)
  })

  it('never defers a certified provider in either mode', () => {
    for (const mode of ['landing', 'production'] as const) {
      expect(classifyProviderCertificationCase(mode, row('opencode')).status).toBe('REQUIRES_LIVE_RECEIPT')
      expect(classifyProviderCertificationCase(mode, row('shell')).status).toBe('REQUIRES_LIVE_RECEIPT')
    }
  })
})

describe('gate outcome resolution', () => {
  const base = {
    caseResults: [{ caseId: 'P1-G01', status: 'PASS' as const }],
    cleanupOk: true,
    unsafeBrokerAttempts: 0,
    primaryError: undefined,
    deferred: [] as string[],
  }

  it('passes a landing run whose only non-pass cases are deferred providers', () => {
    const outcome = resolveGateOutcome({
      ...base,
      mode: 'landing',
      caseResults: [
        { caseId: 'P1-G01', status: 'PASS' },
        { caseId: 'PC-CLAUDE', status: DEFERRED_CASE_STATUS },
      ],
      deferred: ['claude'],
    })
    expect(outcome.status).toBe('PASS')
    expect(outcome.exitCode).toBe(0)
  })

  it('blocks a production run with a typed reason while providers are deferred', () => {
    const outcome = resolveGateOutcome({
      ...base,
      mode: 'production',
      caseResults: [
        { caseId: 'P1-G01', status: 'PASS' },
        { caseId: 'PC-CLAUDE', status: 'BLOCKED', reason: PENDING_LIVE_PROVIDER_CERTIFICATION },
      ],
      deferred: ['claude'],
    })
    expect(outcome.status).toBe('BLOCKED')
    expect(outcome.blockedReason).toBe(PENDING_LIVE_PROVIDER_CERTIFICATION)
    expect(outcome.exitCode).toBe(2)
  })

  it('refuses to defer anything but the three named providers', () => {
    const outcome = resolveGateOutcome({
      ...base,
      mode: 'landing',
      caseResults: [{ caseId: 'PC-OPENCODE', status: DEFERRED_CASE_STATUS }],
      deferred: ['opencode'],
    })
    expect(outcome.status).toBe('FAIL')
    expect(outcome.exitCode).toBe(1)
  })

  it('fails a landing run with any genuine failure or unsafe broker attempt', () => {
    expect(resolveGateOutcome({
      ...base, mode: 'landing', caseResults: [{ caseId: 'P1-G01', status: 'FAIL' }],
    }).status).toBe('FAIL')
    expect(resolveGateOutcome({ ...base, mode: 'landing', unsafeBrokerAttempts: 1 }).status).toBe('FAIL')
    expect(resolveGateOutcome({ ...base, mode: 'landing', cleanupOk: false }).status).toBe('FAIL')
  })

  it('never reports a blocked run as a pass', () => {
    const outcome = resolveGateOutcome({
      ...base,
      mode: 'landing',
      caseResults: [{ caseId: 'P1-G01', status: 'BLOCKED', reason: 'receipt missing' }],
    })
    expect(outcome.status).toBe('BLOCKED')
    expect(outcome.exitCode).toBe(2)
  })
})

describe('manifest loading', () => {
  it('rejects a manifest without an explicit certification block', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-cert-'))
    tempRoots.push(dir)
    fs.mkdirSync(path.join(dir, 'docs/development'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'docs/development/runtime-provider-capabilities.json'),
      JSON.stringify({ schemaVersion: 1, providers: [], doorways: [] }),
    )
    expect(() => loadCapabilityManifest(dir)).toThrow(/certification/i)
  })
})

describe('gate argument parsing', () => {
  it('maps the landing target onto the cumulative phase-5 body in landing mode', () => {
    expect(parseGateArgs(['gate', 'landing', '--require-live'])).toEqual({
      phase: 'phase-5',
      mode: 'landing',
    })
  })

  it('defaults every phase target to the strict production mode', () => {
    expect(parseGateArgs(['gate', 'phase-5', '--require-live'])).toEqual({
      phase: 'phase-5',
      mode: 'production',
    })
  })

  it('honours an explicit mode override', () => {
    expect(parseGateArgs(['gate', 'phase-5', '--mode', 'landing', '--require-live'])).toEqual({
      phase: 'phase-5',
      mode: 'landing',
    })
    expect(parseGateArgs(['gate', 'landing', '--mode', 'production', '--require-live'])).toEqual({
      phase: 'phase-5',
      mode: 'production',
    })
  })

  it('blocks rather than passes when the live flag is absent', () => {
    expect(parseGateArgs(['gate', 'landing'])).toMatchObject({ exitCode: 2 })
  })

  it('rejects an unknown target or mode', () => {
    expect(parseGateArgs(['gate', 'phase-9', '--require-live'])).toMatchObject({ exitCode: 1 })
    expect(parseGateArgs(['gate', 'landing', '--mode', 'lenient', '--require-live'])).toMatchObject({ exitCode: 1 })
  })
})
