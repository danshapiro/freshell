import { execFileSync } from 'node:child_process'
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
import {
  buildProviderQualificationReceipt,
  validateProviderQualificationReceipt,
  type ProviderQualificationRow,
} from '../../../../scripts/testing/provider-qualification-receipt.js'
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

  it('pins managed Amplifier to the actual OneCLI/LunaRoute profile without changing legacy launch', () => {
    const settings = fs.readFileSync(
      path.join(repoRoot, 'docker/runtime/amplifier-onecli-lunaroute-glm53.yaml'),
      'utf8',
    )
    expect(settings).toContain('id: lunaroute')
    expect(settings).toContain('module: provider-vllm')
    expect(settings).toContain('default_model: glm-5.3')
    expect(settings).not.toMatch(/anthropic|haiku|fable|gpt-5\.6-sol|max/i)
    execFileSync('sh', ['-n', path.join(repoRoot, 'docker/runtime/amplifier-onecli')])
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'extensions/amplifier/freshell.json'), 'utf8'),
    )
    expect(manifest.cli.command).toBe('amplifier')
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

describe('provider qualification receipt v2', () => {
  const candidateSha = 'a'.repeat(40)
  const receiptRunId = 'qualification-run-001'
  const runtimeImage = `sha256:${'b'.repeat(64)}`

  function providerRow(provider = 'claude'): ProviderQualificationRow {
    const profile = provider === 'codex'
      ? { providerVersion: '0.147.0', model: 'gpt-5.6-luna', reasoningEffort: 'low', nativeProvider: 'openai' }
      : provider === 'opencode'
        ? { providerVersion: '1.18.21', model: 'opencode/big-pickle', reasoningEffort: 'provider-default', nativeProvider: 'opencode' }
        : provider === 'amplifier'
          ? { providerVersion: '0.1.1', model: 'glm-5.3', reasoningEffort: 'provider-default', nativeProvider: 'lunaroute' }
          : { providerVersion: '2.1.263', model: 'haiku', reasoningEffort: 'low', nativeProvider: 'anthropic' }
    const stages = ['initial', 'after_session_host_crash', 'after_provider_process_crash'] as const
    return {
      provider,
      modes: [provider],
      providerVersion: profile.providerVersion,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      nativeSessionId: '11111111-1111-4111-8111-111111111111',
      nonceSha256: 'd'.repeat(64),
      nativeTurnProofs: stages.map((stage, index) => ({
        schemaVersion: 2 as const,
        stage,
        nativeSessionId: '11111111-1111-4111-8111-111111111111',
        nativeEvidence: provider === 'amplifier'
          ? {
              kind: 'append_only_record' as const,
              recordIndex: index * 2 + 1,
              byteStart: 100 + index * 100,
              byteEnd: 180 + index * 100,
              recordSha256: String(index + 4).repeat(64),
              prefixSha256Before: String(index + 7).repeat(64),
              completionEventOrdinal: index + 1,
              completionEventSha256: String(index + 1).repeat(64),
            }
          : {
              kind: 'identified_message' as const,
              turnId: `turn-${index + 1}`,
              messageId: `message-${index + 1}`,
              parentMessageId: index === 0 ? 'user-1' : `user-${index + 1}`,
            },
        completedAt: `2026-09-01T00:00:0${index + 1}.000Z`,
        responseSha256: String(index + 1).repeat(64),
        responseContainsNonce: true as const,
        toolCallCount: 0,
        toolCallTypes: [],
        resolvedProvider: profile.nativeProvider,
        resolvedModel: profile.model === 'haiku' ? 'claude-haiku-4-5-20251001' : profile.model.replace(/^opencode\//, ''),
        resolvedReasoningEffort: profile.reasoningEffort,
        providerProvenance: `${provider}-native.provider`,
        modelProvenance: `${provider}-native.model`,
        reasoningEffortProvenance: `${provider}-native.effort`,
      })),
      actualProviderBinary: true,
      completedTurn: true,
      nativeStateCaptured: true,
      runtimeOwned: true,
      limitsVerified: true,
      swapMaxVerified: true,
      limitEvidence: {
        cpuMax: '50000 100000',
        memoryMax: '134217728',
        swapMax: '0',
        pidsMax: '64',
      },
      automaticResume: true,
      profileVerified: true,
      releaseBinary: true,
      nativeRecovery: true,
      exactNativeRecovery: true,
      sameNativeSession: true,
      followUpCompleted: true,
      onlyOneWriter: true,
      writerClaim: {
        provider,
        providerStoreId: 'store-qualified',
        nativeSessionId: '11111111-1111-4111-8111-111111111111',
        soulId: 'soul-qualified',
        incarnationId: 'inc-qualified',
        activeClaimCount: 1,
        globalConflictingClaimCount: 0,
      },
      oldEnclosureVerifiedEmpty: true,
      verifiedEmptyOrdering: {
        stopOutcome: 'verified_empty',
        activeClaimCountAfterStop: 0,
        globalConflictingClaimCountAfterStop: 0,
        oldContainerRunningAfterStop: false,
      },
      lostNoticeCount: 0,
      crashKinds: ['session_host', 'provider_process'],
    }
  }

  function evidenceFixture(
    providers = [providerRow()],
    buildKind: 'production' | 'qualification_fixture' = 'production',
  ): {
    repoRoot: string
    evidenceDir: string
    receipt: ReturnType<typeof buildProviderQualificationReceipt>
  } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-qualification-'))
    tempRoots.push(root)
    const evidenceDir = path.join(root, '.runtime-evidence', candidateSha, receiptRunId)
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.mkdirSync(path.join(root, 'docker/runtime'), { recursive: true })
    fs.writeFileSync(path.join(root, 'docker/runtime/provider-versions.json'), JSON.stringify({
      providers: Object.fromEntries(providers.map((row) => [row.provider, { version: row.providerVersion }])),
    }))
    fs.writeFileSync(path.join(evidenceDir, 'manifest.json'), JSON.stringify({
      execution: { candidateSha, runId: receiptRunId },
    }))
    const fakeBinary = { path: '/candidate/freshell', sha256: 'c'.repeat(64), bytes: 123 }
    fs.writeFileSync(path.join(evidenceDir, 'build.json'), JSON.stringify({
      candidateSha,
      runtimeImage,
      qualificationBuild: {
        kind: buildKind,
        serverFeatures: [buildKind === 'qualification_fixture'
          ? 'managed-provider-qualification'
          : 'managed-runtime-v1'],
        supervisorFeatures: buildKind === 'qualification_fixture' ? ['provider-qualification'] : [],
        qualificationProviders: buildKind === 'qualification_fixture'
          ? providers.map((row) => row.provider)
          : [],
        binaries: { server: fakeBinary, supervisor: fakeBinary },
      },
    }))
    fs.writeFileSync(path.join(evidenceDir, 'broker.jsonl'), [
      JSON.stringify({ decision: 'forward', destructive: false, unsafeAttempt: false }),
      JSON.stringify({ decision: 'forward', destructive: true, unsafeAttempt: false }),
    ].join('\n') + '\n')
    fs.writeFileSync(path.join(evidenceDir, 'cleanup.json'), JSON.stringify({
      ok: true,
      errors: [],
      unsafeBrokerAttempts: [],
    }))
    return {
      repoRoot: root,
      evidenceDir,
      receipt: buildProviderQualificationReceipt({
        repoRoot: root,
        evidenceDir,
        candidateSha,
        receiptRunId,
        runtimeImage,
        providers,
      }),
    }
  }

  it('builds a candidate/run/image-bound v2 receipt with hashed evidence artifacts', () => {
    const fixture = evidenceFixture()
    expect(fixture.receipt).toMatchObject({
      schemaVersion: 2,
      status: 'PASS',
      candidateSha,
      receiptRunId,
      evidenceRun: `.runtime-evidence/${candidateSha}/${receiptRunId}`,
      runtimeImage,
      providers: [{
        provider: 'claude',
        providerVersion: '2.1.263',
        model: 'haiku',
        reasoningEffort: 'low',
        nativeSessionId: '11111111-1111-4111-8111-111111111111',
      }],
    })
    for (const artifact of Object.values(fixture.receipt.artifacts)) {
      expect(artifact.path).toMatch(new RegExp(`^\\.runtime-evidence/${candidateSha}/${receiptRunId}/`))
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(validateProviderQualificationReceipt({
      repoRoot: fixture.repoRoot,
      candidateSha,
      expectedRuntimeImage: runtimeImage,
      receipt: fixture.receipt,
      legacyMigration: { gateMode: 'landing', providers: ['opencode'] },
    }).providers).toEqual([providerRow()])
  })

  it('never lets a qualification-only fixture receipt satisfy a production gate', () => {
    const fixture = evidenceFixture([providerRow()], 'qualification_fixture')
    expect(fixture.receipt.qualificationBuild.kind).toBe('qualification_fixture')
    expect(() => validateProviderQualificationReceipt({
      repoRoot: fixture.repoRoot,
      candidateSha,
      expectedRuntimeImage: runtimeImage,
      receipt: fixture.receipt,
    })).toThrow(/qualification_fixture.*production/i)
    expect(validateProviderQualificationReceipt({
      repoRoot: fixture.repoRoot,
      candidateSha,
      expectedRuntimeImage: runtimeImage,
      receipt: fixture.receipt,
      acceptedBuildKinds: ['qualification_fixture'],
    }).providers).toEqual([providerRow()])
  })

  it('binds qualification-fixture rows to the exact pending-provider allowlist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-qualification-selection-'))
    tempRoots.push(root)
    const evidenceDir = path.join(root, '.runtime-evidence', candidateSha, receiptRunId)
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.mkdirSync(path.join(root, 'docker/runtime'), { recursive: true })
    fs.writeFileSync(path.join(root, 'docker/runtime/provider-versions.json'), JSON.stringify({
      providers: { claude: { version: '2.1.263' } },
    }))
    fs.writeFileSync(path.join(evidenceDir, 'manifest.json'), JSON.stringify({
      execution: { candidateSha, runId: receiptRunId },
    }))
    const fakeBinary = { path: '/candidate/freshell', sha256: 'c'.repeat(64), bytes: 123 }
    fs.writeFileSync(path.join(evidenceDir, 'build.json'), JSON.stringify({
      candidateSha,
      runtimeImage,
      qualificationBuild: {
        kind: 'qualification_fixture',
        serverFeatures: ['managed-provider-qualification'],
        supervisorFeatures: ['provider-qualification'],
        qualificationProviders: ['codex'],
        binaries: { server: fakeBinary, supervisor: fakeBinary },
      },
    }))
    fs.writeFileSync(path.join(evidenceDir, 'broker.jsonl'), `${JSON.stringify({ unsafeAttempt: false })}\n`)
    fs.writeFileSync(path.join(evidenceDir, 'cleanup.json'), JSON.stringify({
      ok: true, errors: [], unsafeBrokerAttempts: [],
    }))
    expect(() => buildProviderQualificationReceipt({
      repoRoot: root,
      evidenceDir,
      candidateSha,
      receiptRunId,
      runtimeImage,
      providers: [providerRow('claude')],
    })).toThrow(/allowlist/i)
  })

  it.each([
    ['assertions', 'provider-qualification-assertions.json'],
    ['broker', 'broker.jsonl'],
    ['cleanup', 'cleanup.json'],
  ] as const)('rejects a tampered %s artifact', (_name, fileName) => {
    const fixture = evidenceFixture()
    fs.appendFileSync(path.join(fixture.evidenceDir, fileName), '\nTAMPERED\n')
    expect(() => validateProviderQualificationReceipt({
      repoRoot: fixture.repoRoot,
      candidateSha,
      expectedRuntimeImage: runtimeImage,
      receipt: fixture.receipt,
      legacyMigration: { gateMode: 'landing', providers: ['opencode'] },
    })).toThrow(/digest|sha-256/i)
  })

  it('rejects stale, missing, and path-escaped evidence runs', () => {
    const fixture = evidenceFixture()
    const validate = (receipt: any) => validateProviderQualificationReceipt({
      repoRoot: fixture.repoRoot,
      candidateSha,
      expectedRuntimeImage: runtimeImage,
      receipt,
      legacyMigration: { gateMode: 'landing', providers: ['opencode'] },
    })
    expect(() => validate({ ...fixture.receipt, candidateSha: 'c'.repeat(40) })).toThrow(/candidate/i)
    expect(() => validate({ ...fixture.receipt, receiptRunId: 'another-run' })).toThrow(/evidence run|run id/i)
    expect(() => validate({
      ...fixture.receipt,
      artifacts: {
        ...fixture.receipt.artifacts,
        cleanup: { ...fixture.receipt.artifacts.cleanup, path: '../cleanup.json' },
      },
    })).toThrow(/artifact path|evidence run/i)
    fs.rmSync(path.join(fixture.evidenceDir, 'cleanup.json'))
    expect(() => validate(fixture.receipt)).toThrow(/missing|not found/i)
  })

  it('rejects an evidence directory whose manifest belongs to another run', () => {
    const fixture = evidenceFixture()
    fs.writeFileSync(path.join(fixture.evidenceDir, 'manifest.json'), JSON.stringify({
      execution: { candidateSha, runId: 'stale-run' },
    }))
    expect(() => validateProviderQualificationReceipt({
      repoRoot: fixture.repoRoot,
      candidateSha,
      expectedRuntimeImage: runtimeImage,
      receipt: fixture.receipt,
      legacyMigration: { gateMode: 'landing', providers: ['opencode'] },
    })).toThrow(/manifest run id|candidate-bound/i)
  })

  it('derives cleanup and broker safety from evidence instead of receipt booleans', () => {
    const failedCleanup = evidenceFixture()
    fs.writeFileSync(path.join(failedCleanup.evidenceDir, 'cleanup.json'), JSON.stringify({
      ok: false,
      errors: ['still running'],
      unsafeBrokerAttempts: [],
    }))
    expect(() => buildProviderQualificationReceipt({
      repoRoot: failedCleanup.repoRoot,
      evidenceDir: failedCleanup.evidenceDir,
      candidateSha,
      receiptRunId,
      runtimeImage,
      providers: [providerRow()],
    })).toThrow(/cleanup/i)

    const unsafeBroker = evidenceFixture()
    fs.appendFileSync(path.join(unsafeBroker.evidenceDir, 'broker.jsonl'), `${JSON.stringify({
      decision: 'block', destructive: true, unsafeAttempt: true,
    })}\n`)
    expect(() => buildProviderQualificationReceipt({
      repoRoot: unsafeBroker.repoRoot,
      evidenceDir: unsafeBroker.evidenceDir,
      candidateSha,
      receiptRunId,
      runtimeImage,
      providers: [providerRow()],
    })).toThrow(/unsafe/i)
  })

  it.each([
    ['actualProviderBinary', false],
    ['completedTurn', false],
    ['nativeRecovery', false],
    ['exactNativeRecovery', false],
    ['sameNativeSession', false],
    ['followUpCompleted', false],
    ['onlyOneWriter', false],
    ['limitsVerified', false],
    ['swapMaxVerified', false],
    ['oldEnclosureVerifiedEmpty', false],
    ['lostNoticeCount', 1],
  ] as const)('rejects provider evidence when %s is not qualifying', (field, value) => {
    const row = { ...providerRow(), [field]: value }
    expect(() => evidenceFixture([row])).toThrow(new RegExp(field, 'i'))
  })

  it('requires measured swap.max, a globally unique writer tuple, and post-stop ordering', () => {
    expect(() => evidenceFixture([{
      ...providerRow(),
      limitEvidence: { ...providerRow().limitEvidence, swapMax: 'max' },
    }])).toThrow(/swapMax/i)
    expect(() => evidenceFixture([{
      ...providerRow(),
      writerClaim: { ...providerRow().writerClaim, globalConflictingClaimCount: 1 },
    }])).toThrow(/writerClaim/i)
    expect(() => evidenceFixture([{
      ...providerRow(),
      verifiedEmptyOrdering: {
        ...providerRow().verifiedEmptyOrdering,
        activeClaimCountAfterStop: 1,
      },
    }])).toThrow(/verifiedEmptyOrdering/i)
  })

  it.each(['providerVersion', 'model', 'reasoningEffort', 'nativeSessionId'] as const)(
    'requires the exact provider %s identity',
    (field) => {
      expect(() => evidenceFixture([{ ...providerRow(), [field]: '' }])).toThrow(new RegExp(field, 'i'))
    },
  )

  it('requires three cryptographic native completed-turn proofs for the exact session', () => {
    const row = providerRow()
    expect(() => evidenceFixture([{ ...row, nativeTurnProofs: undefined } as any])).toThrow(/nativeTurnProofs/i)
    expect(() => evidenceFixture([{
      ...row,
      nativeTurnProofs: row.nativeTurnProofs.slice(0, 2),
    }])).toThrow(/three|required stages/i)
    expect(() => evidenceFixture([{
      ...row,
      nativeTurnProofs: row.nativeTurnProofs.map((proof, index) => index === 2
        ? { ...proof, nativeSessionId: 'different-session' }
        : proof),
    }])).toThrow(/nativeSessionId|exact session/i)
    expect(() => evidenceFixture([{
      ...row,
      nativeTurnProofs: row.nativeTurnProofs.map((proof, index) => index === 2
        ? { ...proof, nativeEvidence: { ...proof.nativeEvidence, messageId: (row.nativeTurnProofs[1].nativeEvidence as any).messageId } }
        : proof),
    }])).toThrow(/distinct.*message/i)
  })


  it('accepts Amplifier continuity from native append positions without fabricated message ids', () => {
    const row = providerRow('amplifier') as any
    row.nativeTurnProofs = row.nativeTurnProofs.map((proof: any, index: number) => ({
      ...proof,
      schemaVersion: 2,
      nativeEvidence: {
        kind: 'append_only_record',
        recordIndex: 2 * index + 1,
        byteStart: 100 + index * 100,
        byteEnd: 180 + index * 100,
        recordSha256: String(index + 4).repeat(64),
        prefixSha256Before: String(index + 7).repeat(64),
        completionEventOrdinal: index + 1,
        completionEventSha256: String(index + 1).repeat(64),
      },
    }))
    for (const proof of row.nativeTurnProofs) {
      delete proof.turnId
      delete proof.messageId
      delete proof.parentMessageId
    }
    expect(() => evidenceFixture([row])).not.toThrow()
  })

  it('still requires provider-native IDs where the provider actually exposes them', () => {
    const row = providerRow('codex') as any
    row.nativeTurnProofs[1] = {
      ...row.nativeTurnProofs[1],
      nativeEvidence: { ...row.nativeTurnProofs[1].nativeEvidence, messageId: undefined },
    }
    expect(() => evidenceFixture([row])).toThrow(/message.*id|identified/i)
  })

  it('rejects fabricated Amplifier IDs in place of append-position evidence', () => {
    const row = providerRow('amplifier') as any
    row.nativeTurnProofs = row.nativeTurnProofs.map((proof: any, index: number) => ({
      ...proof,
      nativeEvidence: {
        kind: 'identified_message',
        turnId: `invented-turn-${index}`,
        messageId: `invented-message-${index}`,
        parentMessageId: null,
      },
    }))
    expect(() => evidenceFixture([row])).toThrow(/append|native evidence|Amplifier/i)
  })

  it('requires zero native tool calls for recall and native model/effort provenance', () => {
    const row = providerRow('codex')
    expect(() => evidenceFixture([{
      ...row,
      nativeTurnProofs: row.nativeTurnProofs.map((proof, index) => index === 1
        ? { ...proof, toolCallCount: 1, toolCallTypes: ['function_call:read_file'] }
        : proof),
    }])).toThrow(/tool/i)
    expect(() => evidenceFixture([{
      ...row,
      nativeTurnProofs: row.nativeTurnProofs.map((proof) => ({
        ...proof,
        reasoningEffortProvenance: 'process-args',
      })),
    }])).toThrow(/provenance|process-args/i)
  })

  it('rejects raw prompts, raw responses, nonce values, and synthetic secrets before writing evidence', () => {
    const row = providerRow()
    expect(() => evidenceFixture([{ ...row, responseText: 'harmless raw response' }])).toThrow(/redact|responseText/i)
    expect(() => evidenceFixture([{ ...row, nonce: '00112233445566778899aabbccddeeff' }])).toThrow(/redact|nonce/i)
    expect(() => evidenceFixture([{ ...row, diagnostic: 'Bearer synthetic-secret-value' }])).toThrow(/secret|redact/i)
    expect(() => evidenceFixture([{ ...row, diagnostic: 'sk-synthetic-secret-value' }])).toThrow(/secret|redact/i)
  })

  it('rejects a provider version that differs from the pinned runtime manifest', () => {
    const fixture = evidenceFixture()
    fs.writeFileSync(path.join(fixture.repoRoot, 'docker/runtime/provider-versions.json'), JSON.stringify({
      providers: { claude: { version: 'different-version' } },
    }))
    expect(() => validateProviderQualificationReceipt({
      repoRoot: fixture.repoRoot,
      candidateSha,
      expectedRuntimeImage: runtimeImage,
      receipt: fixture.receipt,
      legacyMigration: { gateMode: 'landing', providers: ['opencode'] },
    })).toThrow(/pinned.*version|providerVersion/i)
  })

  it('rejects receipts whose provider summary differs from the hashed assertion artifact', () => {
    const fixture = evidenceFixture()
    const forged = {
      ...fixture.receipt,
      providers: [{ ...fixture.receipt.providers[0], model: 'more-expensive-model' }],
    }
    expect(() => validateProviderQualificationReceipt({
      repoRoot: fixture.repoRoot,
      candidateSha,
      expectedRuntimeImage: runtimeImage,
      receipt: forged,
      legacyMigration: { gateMode: 'landing', providers: ['opencode'] },
    })).toThrow(/provider.*artifact|summary/i)
  })

  it('allows legacy schema v1 only through the typed OpenCode landing migration, never production', () => {
    const legacyBase = {
      schemaVersion: 1,
      status: 'PASS',
      candidateSha,
      runtimeImage,
    }
    expect(validateProviderQualificationReceipt({
      repoRoot,
      candidateSha,
      expectedRuntimeImage: runtimeImage,
      receipt: { ...legacyBase, providers: [{ provider: 'opencode' }] },
      legacyMigration: { gateMode: 'landing', providers: ['opencode'] },
    }).legacyV1).toBe(true)
    expect(() => validateProviderQualificationReceipt({
      repoRoot,
      candidateSha,
      expectedRuntimeImage: runtimeImage,
      receipt: { ...legacyBase, providers: [{ provider: 'opencode' }] },
    })).toThrow(/landing-only|production acceptance/i)
    expect(() => validateProviderQualificationReceipt({
      repoRoot,
      candidateSha,
      expectedRuntimeImage: runtimeImage,
      receipt: { ...legacyBase, providers: [{ provider: 'claude' }] },
      legacyMigration: { gateMode: 'landing', providers: ['opencode'] },
    })).toThrow(/schema v2|legacy/i)
    const secretLikeProvider = 'sk-abcdefghijklmnopqrstuvwx'
    let failure = ''
    try {
      validateProviderQualificationReceipt({
        repoRoot,
        candidateSha,
        expectedRuntimeImage: runtimeImage,
        receipt: { ...legacyBase, providers: [{ provider: secretLikeProvider }] },
        legacyMigration: { gateMode: 'landing', providers: ['opencode'] },
      })
    } catch (error) {
      failure = String(error)
    }
    expect(failure).not.toContain(secretLikeProvider)
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
