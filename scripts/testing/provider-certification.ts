/**
 * Provider certification state for the Durable Souls release.
 *
 * A provider's durable-soul adapter can be fully implemented and
 * deterministically tested long before any real provider turn has been
 * observed. Those are different claims, so they are tracked on different axes:
 *
 *   - `certificationState` records whether a live, candidate-bound
 *     certification campaign has actually passed;
 *   - `managedEnabled` / `durableRecoveryEnabled` are the release promises that
 *     the runtime, API, and UI act on.
 *
 * The promises may never exceed the certification. This module is the single
 * place that reads the checked-in capability manifest and answers:
 *
 *   - which providers are certified, deferred, or make no claim at all;
 *   - whether the full production gate may even be attempted;
 *   - how one runtime case is classified in landing versus production mode.
 *
 * It is deliberately pure and side-effect free (apart from reading the
 * manifest) so the classification rules are unit-testable without Docker.
 */
import fs from 'node:fs'
import path from 'node:path'

export const PENDING_LIVE_PROVIDER_CERTIFICATION = 'pending_live_provider_certification'
export const DEFERRED_CASE_STATUS = 'DEFERRED_LIVE_PROVIDER_CERTIFICATION'
export const PRODUCTION_BLOCKED_STATUS = 'BLOCKED_PENDING_LIVE_PROVIDER_CERTIFICATION'

export const CAPABILITY_MANIFEST_RELATIVE_PATH = 'docs/development/runtime-provider-capabilities.json'

export type CertificationState =
  | 'certified'
  | 'pending_live_provider_certification'
  | 'not_applicable'

export type GateMode = 'landing' | 'production'

/** Terminal classification of one enumerated runtime case. */
export type CaseStatus = 'PASS' | 'FAIL' | 'BLOCKED' | typeof DEFERRED_CASE_STATUS

export type ProviderRow = {
  provider: string
  certificationState: CertificationState
  managedEnabled: boolean
  durableRecoveryEnabled: boolean
  managedModes: string[]
  liveGate: string
  resumeCommand: string | null
  blockedReason: string | null
  qualificationStatus?: string
}

export type CapabilityManifest = {
  schemaVersion: number
  providers: ProviderRow[]
  doorways: Array<{ id: string; providers: string[]; policy: string; identityRule: string }>
  releaseScope?: {
    managedTerminalProviders?: string[]
    deferredManagedProviders?: string[]
    [key: string]: unknown
  }
  certification: {
    schemaVersion: number
    deferralReason: string
    certifiedDurableProviders: string[]
    deferredProviders: string[]
    landingGate: {
      id: string
      description: string
      deferrableProviders: string[]
      deferredCaseStatus: string
    }
    productionGate: {
      id: string
      status: string
      reason: string
      description: string
      requiredCertifiedProviders: string[]
      blockingProviders: string[]
    }
  }
  [key: string]: unknown
}

export function loadCapabilityManifest(repoRoot: string): CapabilityManifest {
  const manifestPath = path.join(repoRoot, CAPABILITY_MANIFEST_RELATIVE_PATH)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CapabilityManifest
  if (!manifest.certification || typeof manifest.certification !== 'object') {
    throw new Error(
      `${CAPABILITY_MANIFEST_RELATIVE_PATH} has no explicit certification block; the release scope cannot be inferred`,
    )
  }
  for (const row of manifest.providers ?? []) {
    if (!isCertificationState(row.certificationState)) {
      throw new Error(`provider ${row.provider} has no explicit certificationState`)
    }
  }
  return manifest
}

function isCertificationState(value: unknown): value is CertificationState {
  return value === 'certified'
    || value === PENDING_LIVE_PROVIDER_CERTIFICATION
    || value === 'not_applicable'
}

/** Providers that may currently make a production durable-soul promise. */
export function certifiedDurableProviders(manifest: CapabilityManifest): string[] {
  return manifest.providers
    .filter((row) => row.certificationState === 'certified' && row.managedEnabled && row.durableRecoveryEnabled)
    .map((row) => row.provider)
}

/** Providers whose live certification campaign has not run yet. */
export function deferredProviders(manifest: CapabilityManifest): string[] {
  return manifest.providers
    .filter((row) => row.certificationState === PENDING_LIVE_PROVIDER_CERTIFICATION)
    .map((row) => row.provider)
}

export type DeferredProviderEntry = {
  provider: string
  caseId: string
  reason: typeof PENDING_LIVE_PROVIDER_CERTIFICATION
  liveGate: string
  managedModes: string[]
  managedEnabled: boolean
  durableRecoveryEnabled: boolean
  blockedReason: string | null
}

/**
 * The explicit deferred-provider manifest copied into every evidence run. It
 * records what is NOT proven, so a reader never has to infer the gap.
 */
export function deferredProviderManifest(manifest: CapabilityManifest): DeferredProviderEntry[] {
  return manifest.providers
    .filter((row) => row.certificationState === PENDING_LIVE_PROVIDER_CERTIFICATION)
    .map((row) => ({
      provider: row.provider,
      caseId: providerCertificationCaseId(row.provider),
      reason: PENDING_LIVE_PROVIDER_CERTIFICATION,
      liveGate: row.liveGate,
      managedModes: row.managedModes,
      managedEnabled: row.managedEnabled,
      durableRecoveryEnabled: row.durableRecoveryEnabled,
      blockedReason: row.blockedReason,
    }))
}

/**
 * Fail-closed audit: an uncertified provider must make no managed durable
 * promise anywhere in the manifest that the runtime and the public contract
 * both consume.
 */
export function capabilityClaimViolations(manifest: CapabilityManifest): string[] {
  const violations: string[] = []
  const uncertified = new Set(
    manifest.providers
      .filter((row) => row.certificationState !== 'certified')
      .map((row) => row.provider),
  )
  for (const row of manifest.providers) {
    if (row.certificationState === 'certified') {
      if (!row.managedEnabled) {
        violations.push(`${row.provider} is certified but not managed-enabled`)
      }
      continue
    }
    if (row.managedEnabled) {
      violations.push(`${row.provider} is ${row.certificationState} but managedEnabled is true`)
    }
    if (row.durableRecoveryEnabled) {
      violations.push(`${row.provider} is ${row.certificationState} but durableRecoveryEnabled is true`)
    }
    if (row.certificationState === PENDING_LIVE_PROVIDER_CERTIFICATION
      && row.blockedReason !== 'PENDING_LIVE_QUALIFICATION') {
      violations.push(`${row.provider} is deferred without the typed PENDING_LIVE_QUALIFICATION reason`)
    }
  }
  for (const doorway of manifest.doorways ?? []) {
    if (doorway.policy !== 'managed') continue
    for (const provider of doorway.providers) {
      if (uncertified.has(provider)) {
        violations.push(`doorway ${doorway.id} routes uncertified provider ${provider} as managed`)
      }
    }
  }
  const declaredDeferred = manifest.certification.deferredProviders ?? []
  const actualDeferred = deferredProviders(manifest)
  if (JSON.stringify(declaredDeferred) !== JSON.stringify(actualDeferred)) {
    violations.push(
      `certification.deferredProviders ${JSON.stringify(declaredDeferred)} does not match provider rows ${JSON.stringify(actualDeferred)}`,
    )
  }
  const declaredCertified = manifest.certification.certifiedDurableProviders ?? []
  const actualCertified = certifiedDurableProviders(manifest)
  if (JSON.stringify(declaredCertified) !== JSON.stringify(actualCertified)) {
    violations.push(
      `certification.certifiedDurableProviders ${JSON.stringify(declaredCertified)} does not match provider rows ${JSON.stringify(actualCertified)}`,
    )
  }
  return violations
}

export function providerCertificationCaseId(provider: string): string {
  return `PC-${provider.toUpperCase()}`
}

/**
 * One certification case per provider that either makes a managed claim today
 * or is queued to make one. Providers with no claim at all (legacy extensions)
 * are intentionally absent rather than recorded as trivially passing.
 */
export function providerCertificationCaseIds(manifest: CapabilityManifest): string[] {
  return manifest.providers
    .filter((row) => row.managedEnabled || row.certificationState === PENDING_LIVE_PROVIDER_CERTIFICATION)
    .map((row) => providerCertificationCaseId(row.provider))
}

/**
 * The whole certification case set, including the release-scope audit that
 * runs before any provider is classified. Every assertion a certification run
 * records belongs to one of these ids, so expected and actual sets match
 * exactly rather than by count.
 */
export const RELEASE_SCOPE_CASE_ID = 'PC-SCOPE'

export function certificationCaseIds(manifest: CapabilityManifest): string[] {
  return [RELEASE_SCOPE_CASE_ID, ...providerCertificationCaseIds(manifest)]
}

export type ProductionCertificationStatus = {
  status: typeof PRODUCTION_BLOCKED_STATUS | 'ELIGIBLE'
  reason: string | null
  blockingProviders: string[]
  requiredProviders: string[]
}

/**
 * The full production gate may only be attempted once every provider it will
 * advertise is live-certified. While any remain pending it is BLOCKED, and
 * BLOCKED is never PASS.
 */
export function productionCertificationStatus(manifest: CapabilityManifest): ProductionCertificationStatus {
  const required = manifest.certification.productionGate.requiredCertifiedProviders ?? []
  const byProvider = new Map(manifest.providers.map((row) => [row.provider, row]))
  const blocking = required.filter((provider) => byProvider.get(provider)?.certificationState !== 'certified')
  return {
    status: blocking.length ? PRODUCTION_BLOCKED_STATUS : 'ELIGIBLE',
    reason: blocking.length ? PENDING_LIVE_PROVIDER_CERTIFICATION : null,
    blockingProviders: blocking,
    requiredProviders: required,
  }
}

export type ProviderCaseClassification = {
  status: typeof DEFERRED_CASE_STATUS | 'BLOCKED' | 'REQUIRES_LIVE_RECEIPT' | 'NOT_APPLICABLE'
  reason: string | null
}

/**
 * How one provider's certification case is treated in each gate mode.
 * `REQUIRES_LIVE_RECEIPT` means the case must actually execute and prove a
 * candidate-bound live receipt; it is never satisfied by deferral.
 */
export function classifyProviderCertificationCase(
  mode: GateMode,
  row: ProviderRow,
): ProviderCaseClassification {
  if (row.certificationState === 'certified') {
    return { status: 'REQUIRES_LIVE_RECEIPT', reason: null }
  }
  if (row.certificationState === PENDING_LIVE_PROVIDER_CERTIFICATION) {
    return mode === 'landing'
      ? { status: DEFERRED_CASE_STATUS, reason: PENDING_LIVE_PROVIDER_CERTIFICATION }
      : { status: 'BLOCKED', reason: PENDING_LIVE_PROVIDER_CERTIFICATION }
  }
  return { status: 'NOT_APPLICABLE', reason: null }
}

export type CaseResult = {
  caseId: string
  status: CaseStatus | 'REQUIRES_LIVE_RECEIPT' | 'NOT_APPLICABLE'
  reason?: string
  provider?: string
}

export type GateOutcomeInput = {
  mode: GateMode
  caseResults: CaseResult[]
  cleanupOk: boolean
  unsafeBrokerAttempts: number
  primaryError?: unknown
  /** Providers the run treated as deferred. */
  deferred?: string[]
  /** Providers the manifest actually permits deferring. */
  deferrableProviders?: string[]
}

export type GateOutcome = {
  status: 'PASS' | 'FAIL' | 'BLOCKED'
  exitCode: 0 | 1 | 2
  blockedReason: string | null
  failures: string[]
  deferred: string[]
}

const DEFAULT_DEFERRABLE = ['claude', 'codex', 'amplifier']

/**
 * Resolve the whole run. A landing run may pass with exactly the manifest's
 * deferrable providers deferred; anything else that is not a PASS keeps the
 * run out of PASS. A production run with deferred providers is BLOCKED with
 * the typed reason and is never reported as a pass.
 */
export function resolveGateOutcome(input: GateOutcomeInput): GateOutcome {
  const deferrable = new Set(input.deferrableProviders ?? DEFAULT_DEFERRABLE)
  const deferred = input.deferred ?? []
  const failures: string[] = []

  if (input.primaryError !== undefined) {
    failures.push(input.primaryError instanceof Error ? input.primaryError.message : String(input.primaryError))
  }
  if (!input.cleanupOk) failures.push('cleanup did not verify')
  if (input.unsafeBrokerAttempts > 0) {
    failures.push(`${input.unsafeBrokerAttempts} unsafe destructive broker attempt(s)`)
  }
  for (const provider of deferred) {
    if (!deferrable.has(provider)) {
      failures.push(`provider ${provider} may not be deferred`)
    }
  }

  const blocked: string[] = []
  for (const result of input.caseResults) {
    if (result.status === 'FAIL') {
      failures.push(`${result.caseId} failed`)
      continue
    }
    if (result.status === 'BLOCKED') {
      blocked.push(result.reason ?? result.caseId)
      continue
    }
    if (result.status === DEFERRED_CASE_STATUS) {
      if (input.mode !== 'landing') {
        failures.push(`${result.caseId} may not be deferred in production mode`)
      } else if (result.provider && !deferrable.has(result.provider)) {
        failures.push(`${result.caseId} may not be deferred`)
      }
      continue
    }
    if (result.status !== 'PASS') {
      failures.push(`${result.caseId} ended in unresolved status ${result.status}`)
    }
  }

  if (failures.length) {
    return { status: 'FAIL', exitCode: 1, blockedReason: null, failures, deferred }
  }
  if (blocked.length) {
    return {
      status: 'BLOCKED',
      exitCode: 2,
      blockedReason: blocked.includes(PENDING_LIVE_PROVIDER_CERTIFICATION)
        ? PENDING_LIVE_PROVIDER_CERTIFICATION
        : blocked[0],
      failures: [],
      deferred,
    }
  }
  return { status: 'PASS', exitCode: 0, blockedReason: null, failures: [], deferred }
}
