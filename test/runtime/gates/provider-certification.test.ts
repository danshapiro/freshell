/**
 * Provider certification cases (`PC-*`).
 *
 * These are the release-scope cases that sit above the phase gates: for every
 * provider that makes — or is queued to make — a managed durable-soul promise,
 * exactly one case records whether that promise is actually proven.
 *
 * A certified provider must present a candidate-bound live receipt. A provider
 * awaiting live access is DEFERRED in landing mode (after proving it makes no
 * production promise anywhere) and BLOCKED in production mode. Deferral is
 * never a pass, and a certified provider can never be deferred.
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  DEFERRED_CASE_STATUS,
  PENDING_LIVE_PROVIDER_CERTIFICATION,
  type CapabilityManifest,
  type CaseResult,
  type GateMode,
  type ProviderRow,
  capabilityClaimViolations,
  classifyProviderCertificationCase,
  deferredProviderManifest,
  loadCapabilityManifest,
  productionCertificationStatus,
  providerCertificationCaseId,
  providerCertificationCaseIds,
} from '../../../scripts/testing/provider-certification.js'
import type { RuntimeHarness } from '../../../scripts/testing/runtime-sandbox.js'

export function providerCertificationCaseIdsFor(repoRoot: string): string[] {
  return providerCertificationCaseIds(loadCapabilityManifest(repoRoot))
}

export type ProviderCertificationRunResult = {
  caseResults: CaseResult[]
  deferred: string[]
  manifest: CapabilityManifest
}

/**
 * The candidate-bound receipt that proves a certified durable provider really
 * ran live. It is the same receipt the phase-5 provider matrix consumes, so a
 * certification can never be satisfied by a differently sourced artifact.
 */
function readProviderReceipt(h: RuntimeHarness, caseId: string): any | null {
  const raw = process.env.FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT
  if (!raw?.trim()) return null
  const receipt = JSON.parse(raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8'))
  h.writeBrowserArtifact(`${caseId}-provider-receipt`, receipt)
  return receipt
}

export async function runProviderCertificationGate(
  h: RuntimeHarness,
  mode: GateMode,
): Promise<ProviderCertificationRunResult> {
  const manifest = loadCapabilityManifest(h.repoRoot)
  const caseResults: CaseResult[] = []
  const deferred: string[] = []

  // Release-scope audit runs first: a deferred provider that leaked a managed
  // promise invalidates every downstream classification.
  const violations = capabilityClaimViolations(manifest)
  h.assert(
    'PC-SCOPE',
    violations.length === 0,
    'no uncertified provider advertises a managed durable-soul promise',
    violations,
  )

  const production = productionCertificationStatus(manifest)
  h.assert(
    'PC-SCOPE',
    production.status === 'BLOCKED_PENDING_LIVE_PROVIDER_CERTIFICATION' || production.blockingProviders.length === 0,
    'production certification status is derived from the manifest, not asserted',
    production,
  )

  const eligible = manifest.providers.filter(
    (row) => row.managedEnabled || row.certificationState === PENDING_LIVE_PROVIDER_CERTIFICATION,
  )
  const expectedIds = providerCertificationCaseIds(manifest)
  const actualIds = eligible.map((row) => providerCertificationCaseId(row.provider))
  h.assert('PC-SCOPE', JSON.stringify(expectedIds) === JSON.stringify(actualIds), 'certification case set is exact', {
    expectedIds,
    actualIds,
  })

  const receipt = readProviderReceipt(h, 'PC-RECEIPT')

  for (const row of eligible) {
    const caseId = providerCertificationCaseId(row.provider)
    h.recordLifecycle('gate.case.started', { caseId, mode })
    const classification = classifyProviderCertificationCase(mode, row)

    if (classification.status === DEFERRED_CASE_STATUS) {
      assertNoProductionPromise(h, caseId, manifest, row)
      deferred.push(row.provider)
      caseResults.push({
        caseId,
        status: DEFERRED_CASE_STATUS,
        reason: PENDING_LIVE_PROVIDER_CERTIFICATION,
        provider: row.provider,
      })
      h.writeIncident(`${caseId}-deferred`, {
        caseId,
        provider: row.provider,
        reason: PENDING_LIVE_PROVIDER_CERTIFICATION,
        liveGate: row.liveGate,
      })
      h.recordLifecycle('gate.case.deferred', { caseId, provider: row.provider })
      continue
    }

    if (classification.status === 'BLOCKED') {
      assertNoProductionPromise(h, caseId, manifest, row)
      caseResults.push({
        caseId,
        status: 'BLOCKED',
        reason: PENDING_LIVE_PROVIDER_CERTIFICATION,
        provider: row.provider,
      })
      h.recordLifecycle('gate.case.blocked', {
        caseId,
        provider: row.provider,
        reason: PENDING_LIVE_PROVIDER_CERTIFICATION,
      })
      continue
    }

    // REQUIRES_LIVE_RECEIPT
    if (!row.durableRecoveryEnabled) {
      // Managed isolation without a durability claim (shell). Its live gate is
      // deterministic by construction, so the cumulative phase cases are its
      // proof; there is no provider account to bill.
      h.assert(caseId, row.liveGate === 'deterministic-shell', 'non-durable certified provider uses the deterministic gate', row)
      h.assert(caseId, row.resumeCommand == null, 'non-durable certified provider claims no resume command', row)
      caseResults.push({ caseId, status: 'PASS', provider: row.provider })
      h.recordLifecycle('gate.case.passed', { caseId, provider: row.provider })
      continue
    }

    if (!receipt) {
      caseResults.push({
        caseId,
        status: 'BLOCKED',
        reason: `certified provider ${row.provider} has no candidate-bound live receipt; set FRESHELL_RUNTIME_PHASE5_PROVIDER_RECEIPT`,
        provider: row.provider,
      })
      h.recordLifecycle('gate.case.blocked', { caseId, provider: row.provider, reason: 'missing live receipt' })
      continue
    }

    const providerRow = (Array.isArray(receipt.providers) ? receipt.providers : [])
      .find((candidate: any) => candidate.provider === row.provider)
    h.assert(caseId, Boolean(providerRow), `live receipt covers certified provider ${row.provider}`, receipt)
    h.assert(caseId, receipt.candidateSha === h.candidateSha, 'live receipt is bound to the exact candidate commit', receipt)
    h.assert(caseId, receipt.status === 'PASS', 'live receipt is an explicit PASS', receipt)
    const modes = new Set(Array.isArray(providerRow?.modes) ? providerRow.modes : [])
    for (const managedMode of row.managedModes) {
      h.assert(caseId, modes.has(managedMode), `live receipt covers ${row.provider} mode ${managedMode}`, providerRow)
    }
    // The field names are the provider-qualification receipt's own contract
    // (see runtime-opencode-provider-qualification-rust.spec.ts). A
    // certification is exactly: a real provider binary completed a real turn,
    // recovery kept the exact native session, and a follow-up in that same
    // conversation worked afterwards.
    h.assert(caseId, providerRow?.actualProviderBinary === true, `${row.provider} receipt used the real provider binary`, providerRow)
    h.assert(caseId, providerRow?.completedTurn === true, `${row.provider} receipt contains a completed live turn`, providerRow)
    h.assert(caseId, providerRow?.nativeRecovery === true, `${row.provider} recovered through its native path`, providerRow)
    h.assert(caseId, providerRow?.sameNativeSession === true, `${row.provider} kept its exact native session across recovery`, providerRow)
    h.assert(caseId, providerRow?.followUpCompleted === true, `${row.provider} follow-up worked after recovery`, providerRow)
    h.assert(caseId, providerRow?.lostNoticeCount === 0, `${row.provider} produced no false loss notice`, providerRow)
    h.assert(caseId, providerRow?.cleanupVerified === true, `${row.provider} cleanup verified empty`, providerRow)
    h.assert(caseId, providerRow?.unsafeAttempts === 0, `${row.provider} made zero unsafe broker attempts`, providerRow)
    caseResults.push({ caseId, status: 'PASS', provider: row.provider })
    h.recordLifecycle('gate.case.passed', { caseId, provider: row.provider })
  }

  fs.writeFileSync(
    path.join(h.evidenceDir, 'deferred-providers.json'),
    JSON.stringify(
      {
        mode,
        deferralReason: PENDING_LIVE_PROVIDER_CERTIFICATION,
        deferred: deferredProviderManifest(manifest),
        productionCertification: production,
      },
      null,
      2,
    ),
  )

  return { caseResults, deferred, manifest }
}

/**
 * An uncertified provider must be inert at every release surface: no managed
 * enablement, no durable recovery claim, and no managed doorway. This is the
 * assertion that keeps "deferred" from quietly meaning "shipped anyway".
 */
function assertNoProductionPromise(
  h: RuntimeHarness,
  caseId: string,
  manifest: CapabilityManifest,
  row: ProviderRow,
): void {
  h.assert(caseId, row.managedEnabled === false, `${row.provider} is not managed-enabled while uncertified`, row)
  h.assert(caseId, row.durableRecoveryEnabled === false, `${row.provider} claims no durable recovery while uncertified`, row)
  h.assert(caseId, row.blockedReason === 'PENDING_LIVE_QUALIFICATION', `${row.provider} carries the typed pending reason`, row)
  const managedDoorways = (manifest.doorways ?? []).filter(
    (doorway) => doorway.policy === 'managed' && doorway.providers.includes(row.provider),
  )
  h.assert(caseId, managedDoorways.length === 0, `${row.provider} is routed by no managed doorway`, managedDoorways)
  const releaseScope: any = (manifest as any).releaseScope ?? {}
  h.assert(
    caseId,
    !(releaseScope.managedTerminalProviders ?? []).includes(row.provider),
    `${row.provider} is absent from the managed terminal release scope`,
    releaseScope,
  )
}
