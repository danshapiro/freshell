/**
 * Cumulative managed-runtime gate runner.
 *
 * Two release modes share one cumulative body of cases:
 *
 *   - `--mode landing` (also reachable as `gate landing`) is the
 *     pre-certification gate. It may PASS while exactly the providers the
 *     capability manifest marks `pending_live_provider_certification` are
 *     recorded as DEFERRED_LIVE_PROVIDER_CERTIFICATION. Every other case must
 *     genuinely PASS.
 *   - `--mode production` (the default for `gate phase-5`) is the full
 *     production certification. While any required provider is uncertified it
 *     reports BLOCKED with the typed `pending_live_provider_certification`
 *     reason and exit code 2. BLOCKED is never PASS.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { RuntimeHarness } from './runtime-sandbox.js'
import {
  DEFERRED_CASE_STATUS,
  PENDING_LIVE_PROVIDER_CERTIFICATION,
  type CaseResult,
  type GateMode,
  deferredProviderManifest,
  loadCapabilityManifest,
  productionCertificationStatus,
  resolveGateOutcome,
} from './provider-certification.js'
import { type GatePhase, parseGateArgs } from './runtime-gate-args.js'
import { auditRuntimeArtifacts, candidateIntegrityFailures, captureRuntimeCandidate, type RuntimeCandidate } from './runtime-gate-integrity.js'
import { PHASE1_CASE_IDS, runPhase1Gate, validateRequiredCoverage } from '../../test/runtime/gates/phase-1.test.js'
import { PHASE2_CASE_IDS, runPhase2Gate } from '../../test/runtime/gates/phase-2.test.js'
import { PHASE3_CASE_IDS, runPhase3Gate } from '../../test/runtime/gates/phase-3.test.js'
import { PHASE4_CASE_IDS, runPhase4Gate } from '../../test/runtime/gates/phase-4.test.js'
import { PHASE5_CASE_IDS, runPhase5Gate } from '../../test/runtime/gates/phase-5.test.js'
import { runProviderCertificationGate } from '../../test/runtime/gates/provider-certification.test.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

async function main(): Promise<number> {
  const parsed = parseGateArgs(process.argv.slice(2))
  if ('error' in parsed) {
    console.error(parsed.error)
    return parsed.exitCode
  }
  const { phase, mode } = parsed

  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'test/runtime/gate-manifest.json'), 'utf8'))
  const phaseManifest = manifest.phases.find((candidate: any) => candidate.id === phase)
  if (!phaseManifest) {
    console.error(`FAIL: ${phase} is absent from test/runtime/gate-manifest.json`)
    return 1
  }
  const requiredCases = phaseManifest.cumulative_required_case_ids as string[]
  const codeCases = phase === 'phase-1'
    ? [...PHASE1_CASE_IDS]
    : phase === 'phase-2'
      ? [...PHASE1_CASE_IDS, ...PHASE2_CASE_IDS]
      : phase === 'phase-3'
        ? [...PHASE1_CASE_IDS, ...PHASE2_CASE_IDS, ...PHASE3_CASE_IDS]
        : phase === 'phase-4'
          ? [...PHASE1_CASE_IDS, ...PHASE2_CASE_IDS, ...PHASE3_CASE_IDS, ...PHASE4_CASE_IDS]
          : [...PHASE1_CASE_IDS, ...PHASE2_CASE_IDS, ...PHASE3_CASE_IDS, ...PHASE4_CASE_IDS, ...PHASE5_CASE_IDS]
  if (JSON.stringify([...requiredCases].sort()) !== JSON.stringify([...codeCases].sort())) {
    console.error(`FAIL: gate implementation/manifest mismatch. manifest=${[...requiredCases].sort().join(',')} code=${[...codeCases].sort().join(',')}`)
    return 1
  }

  const capabilities = loadCapabilityManifest(repoRoot)
  const certification = manifest.certification_gates
  if (!certification) {
    console.error('FAIL: test/runtime/gate-manifest.json has no certification_gates block')
    return 1
  }
  const declaredCertificationCases = certification.provider_certification_case_ids as string[]

  const harness: RuntimeHarness = new RuntimeHarness(
    repoRoot,
    undefined,
    phase === 'phase-5' ? 5 : phase === 'phase-4' ? 4 : phase === 'phase-3' ? 3 : phase === 'phase-2' ? 2 : 1,
  )
  const candidateBefore = captureRuntimeCandidate(repoRoot)
  if (candidateBefore.dirty || candidateBefore.sha !== harness.candidateSha) {
    // Do not spend provider budget or create containers for evidence that
    // cannot certify this commit. Incomplete preflight is BLOCKED, never PASS.
    fs.mkdirSync(harness.evidenceDir, { recursive: true })
    const summary = {
      phase,
      mode,
      status: 'BLOCKED',
      blockedReason: 'uncommitted_or_changed_candidate',
      candidateSha: harness.candidateSha,
      runId: harness.runId,
      preflightOnly: true,
      candidate: candidateBefore,
      requiredCases,
      executedCases: [],
      cleanup: { ok: true, required: false, reason: 'no test resources created' },
    }
    harness.writeSummary(summary)
    console.error(JSON.stringify({ ...summary, evidenceDir: harness.evidenceDir }, null, 2))
    return 2
  }
  const executed: string[] = []
  const blockedCases: Array<{ caseId: string; message: string; evidence?: unknown }> = []
  let certificationResults: CaseResult[] = []
  let deferred: string[] = []
  let primaryError: unknown
  let cleanup = { ok: false, errors: ['cleanup not attempted'] }
  const startedAt = new Date().toISOString()
  try {
    await harness.prepare()
    await runPhase1Gate(harness, (caseId) => executed.push(caseId))
    validateRequiredCoverage(PHASE1_CASE_IDS, executed.filter((id) => id.startsWith('P1-')))

    if (phase === 'phase-2' || phase === 'phase-3' || phase === 'phase-4' || phase === 'phase-5') {
      const result = await runPhase2Gate(harness, (caseId) => executed.push(caseId))
      blockedCases.push(...result.blocked)
    }

    if (phase === 'phase-3' || phase === 'phase-4' || phase === 'phase-5') {
      const result = await runPhase3Gate(harness, (caseId) => executed.push(caseId))
      blockedCases.push(...result.blocked)
    }

    if (phase === 'phase-4' || phase === 'phase-5') {
      const result = await runPhase4Gate(harness, (caseId) => executed.push(caseId))
      blockedCases.push(...result.blocked)
    }

    if (phase === 'phase-5') {
      const result = await runPhase5Gate(harness, (caseId) => executed.push(caseId))
      blockedCases.push(...result.blocked)
    }

    const certificationRun = await runProviderCertificationGate(harness, mode)
    certificationResults = certificationRun.caseResults
    deferred = certificationRun.deferred
    const actualCertificationCases = certificationResults.map((row) => row.caseId)
    if (JSON.stringify(actualCertificationCases) !== JSON.stringify(declaredCertificationCases)) {
      throw new Error(
        `certification case set drifted. manifest=${declaredCertificationCases.join(',')} run=${actualCertificationCases.join(',')}`,
      )
    }

    const safetyCase = phase === 'phase-5'
      ? 'P5-G12'
      : phase === 'phase-4'
      ? 'P4-G11'
      : phase === 'phase-3'
      ? 'P3-G12'
      : phase === 'phase-2'
        ? 'P2-G11'
        : 'P1-G10'
    harness.assert(
      safetyCase,
      harness.broker.unsafeAttempts().length === 0,
      'no unsafe destructive Docker request occurred anywhere in the cumulative live gate',
      harness.broker.unsafeAttempts(),
    )
  } catch (error) {
    primaryError = error
  } finally {
    try {
      cleanup = await harness.cleanup()
    } catch (error) {
      cleanup = { ok: false, errors: [`cleanup threw: ${String(error)}`] }
      primaryError ??= error
    }
  }

  const blockedById = new Map(blockedCases.map((row) => [row.caseId, row]))
  const phaseCaseResults: CaseResult[] = requiredCases.map((caseId) => {
    const blocked = blockedById.get(caseId)
    if (blocked) return { caseId, status: 'BLOCKED', reason: blocked.message }
    if (executed.includes(caseId)) return { caseId, status: 'PASS' }
    return { caseId, status: 'FAIL', reason: 'required case did not execute' }
  })
  const caseResults = [...phaseCaseResults, ...certificationResults]

  // The manifest declares the artifacts a valid run must contain. Enforce it:
  // an evidence tree missing its own declared receipts is not reviewable, and
  // "the assertion passed" is not the same as "the evidence exists".
  const declaredArtifacts: string[] = [
    ...(manifest.execution_contract?.required_artifacts ?? []),
    ...(phaseManifest.required_artifacts ?? []),
    ...(certification.required_artifacts ?? []),
  ]
  const artifactAudit = auditRuntimeArtifacts(harness.evidenceDir, declaredArtifacts)
  const missingArtifacts = artifactAudit.missing
  const invalidArtifacts = artifactAudit.invalid
  const artifactResults: CaseResult[] = missingArtifacts.length || invalidArtifacts.length
    ? [{
        caseId: 'EVIDENCE-ARTIFACTS',
        status: 'FAIL',
        reason: `missing declared artifacts: ${missingArtifacts.join(', ')}; invalid artifacts: ${invalidArtifacts.map((row) => `${row.artifact}: ${row.reason}`).join('; ')}`,
      }]
    : [{ caseId: 'EVIDENCE-ARTIFACTS', status: 'PASS' }]

  let candidateAfter: RuntimeCandidate | null = null
  let candidateFailures: string[]
  try {
    candidateAfter = captureRuntimeCandidate(repoRoot)
    candidateFailures = candidateIntegrityFailures(harness.candidateSha, candidateBefore, candidateAfter)
  } catch {
    candidateFailures = ['could not verify candidate inputs after qualification']
  }
  const candidateResults: CaseResult[] = [{
    caseId: 'EVIDENCE-CANDIDATE',
    status: candidateFailures.length ? 'FAIL' : 'PASS',
    ...(candidateFailures.length ? { reason: candidateFailures.join('; ') } : {}),
  }]
  const allCaseResults = [...caseResults, ...artifactResults, ...candidateResults]

  const unsafeDockerAttempts = harness.broker?.unsafeAttempts?.() ?? []
  const outcome = resolveGateOutcome({
    mode,
    caseResults: allCaseResults,
    expectedCaseIds: [...requiredCases, ...declaredCertificationCases, 'EVIDENCE-ARTIFACTS', 'EVIDENCE-CANDIDATE'],
    cleanupOk: cleanup.ok,
    unsafeBrokerAttempts: unsafeDockerAttempts.length,
    primaryError,
    deferred,
    deferrableProviders: capabilities.certification.landingGate.deferrableProviders,
  })
  const production = productionCertificationStatus(capabilities)

  const summary = {
    gate: mode === 'landing' ? capabilities.certification.landingGate.id : capabilities.certification.productionGate.id,
    mode,
    phase,
    status: outcome.status,
    blockedReason: outcome.blockedReason,
    failures: outcome.failures,
    startedAt,
    finishedAt: new Date().toISOString(),
    candidateSha: harness.candidateSha,
    runId: harness.runId,
    imageRef: harness.imageRef,
    requiredCases,
    providerCertificationCases: declaredCertificationCases,
    executedCases: executed,
    caseResults: allCaseResults,
    missingArtifacts,
    invalidArtifacts,
    candidateIntegrity: { before: candidateBefore, after: candidateAfter, failures: candidateFailures },
    counts: {
      pass: allCaseResults.filter((row) => row.status === 'PASS').length,
      deferred: allCaseResults.filter((row) => row.status === DEFERRED_CASE_STATUS).length,
      blocked: allCaseResults.filter((row) => row.status === 'BLOCKED').length,
      failed: allCaseResults.filter((row) => row.status === 'FAIL').length,
    },
    blockedCases,
    deferredProviders: deferred,
    deferredProviderManifest: deferredProviderManifest(capabilities),
    productionGate: {
      id: capabilities.certification.productionGate.id,
      status: production.status,
      reason: production.reason ?? PENDING_LIVE_PROVIDER_CERTIFICATION,
      blockingProviders: production.blockingProviders,
    },
    cleanup,
    unsafeDockerAttempts,
    error: primaryError instanceof Error
      ? { message: primaryError.message, stack: primaryError.stack }
      : primaryError === undefined ? null : String(primaryError),
  }
  harness.writeSummary(summary)
  console.log(JSON.stringify({ ...summary, evidenceDir: harness.evidenceDir }, null, 2))
  return outcome.exitCode
}

process.exitCode = await main()
