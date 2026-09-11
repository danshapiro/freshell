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

export type FreshAgentModeRow = {
  mode: string
  provider: string
  runtimeVariant: string
  hostOwnedImplementation: boolean
  enabledInReleaseScope: boolean
  liveQualificationStatus: 'pending_authentic_receipt' | 'certified'
  certified: boolean
  pendingApprovalSupported: boolean
}

export type CapabilityManifest = {
  schemaVersion: number
  providers: ProviderRow[]
  freshAgentModes: FreshAgentModeRow[]
  doorways: Array<{
    id: string
    providers: string[]
    policy: string
    identityRule: string
    enabledInReleaseScope?: boolean
  }>
  releaseScope?: {
    managedTerminalProviders?: string[]
    deferredManagedProviders?: string[]
    disabledFreshAgentModes?: string[]
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

export function releasedFreshAgentModes(manifest: CapabilityManifest): FreshAgentModeRow[] {
  return (manifest.freshAgentModes ?? []).filter((row) => row.enabledInReleaseScope)
}

/**
 * Fresh-agent implementation and release certification are independent axes.
 * `passedModes` is the set a release gate is about to record as PASS; feeding
 * a disabled row is itself a structural failure rather than harmless extra
 * evidence.
 */
export function freshAgentReleaseScopeViolations(
  manifest: CapabilityManifest,
  passedModes: readonly string[],
): string[] {
  const violations: string[] = []
  const rows = manifest.freshAgentModes ?? []
  const expectedModes = ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode']
  const declaredModes = rows.map((row) => row.mode)
  if (JSON.stringify(declaredModes) !== JSON.stringify(expectedModes)) {
    violations.push(`freshAgentModes must declare exactly ${JSON.stringify(expectedModes)}`)
  }
  for (const mode of duplicates(declaredModes)) violations.push(`duplicate fresh-agent mode declaration: ${mode}`)
  const byMode = new Map(rows.map((row) => [row.mode, row]))
  const anyEnabled = rows.some((row) => row.enabledInReleaseScope)
  if (manifest.releaseScope?.freshAgentEnabled !== anyEnabled) {
    violations.push('releaseScope.freshAgentEnabled must exactly match the per-mode release scope')
  }
  for (const row of rows) {
    if (!row.hostOwnedImplementation && row.enabledInReleaseScope) {
      violations.push(`${row.mode} is released without a host-owned implementation`)
    }
    if (row.enabledInReleaseScope
      && (row.certified !== true || row.liveQualificationStatus !== 'certified')) {
      violations.push(`${row.mode} is released without a live candidate-bound receipt certification`)
    }
    if (!row.enabledInReleaseScope && row.certified === true) {
      violations.push(`${row.mode} is disabled but carries a certification PASS flag`)
    }
    const doorway = manifest.doorways.find((candidate) => candidate.id === `rest-${row.mode}-create`)
    const expectedPolicy = row.enabledInReleaseScope ? 'managed' : 'blocked'
    if (!doorway
      || doorway.providers.length !== 1
      || doorway.providers[0] !== row.provider
      || doorway.policy !== expectedPolicy
      || doorway.enabledInReleaseScope !== row.enabledInReleaseScope) {
      violations.push(`${row.mode} REST doorway does not exactly match its release scope`)
    }
  }
  for (const mode of duplicates(passedModes)) violations.push(`duplicate fresh-agent PASS row: ${mode}`)
  for (const mode of passedModes) {
    const row = byMode.get(mode)
    if (!row) violations.push(`unknown fresh-agent mode ${mode} was counted as PASS`)
    else if (!row.enabledInReleaseScope) violations.push(`${mode} is disabled but was accidentally included as PASS`)
  }
  const disabled = rows.filter((row) => !row.enabledInReleaseScope).map((row) => row.mode)
  if (JSON.stringify(manifest.releaseScope?.disabledFreshAgentModes ?? []) !== JSON.stringify(disabled)) {
    violations.push('releaseScope.disabledFreshAgentModes does not exactly match freshAgentModes status rows')
  }
  return violations
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
function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  return [...new Set(values.filter((value) => {
    if (seen.has(value)) return true
    seen.add(value)
    return false
  }))]
}

export function capabilityClaimViolations(manifest: CapabilityManifest): string[] {
  const violations: string[] = [...freshAgentReleaseScopeViolations(manifest, [])]
  const byProvider = new Map(manifest.providers.map((row) => [row.provider, row]))
  for (const provider of duplicates(manifest.providers.map((row) => row.provider))) {
    violations.push(`duplicate provider declaration: ${provider}`)
  }

  // Scope is policy, not documentation. Validate all references, not only the
  // flags on known rows: an unknown name used to escape the uncertified set.
  for (const provider of manifest.releaseScope?.managedTerminalProviders ?? []) {
    const row = byProvider.get(provider)
    if (!row || row.certificationState !== 'certified' || !row.managedEnabled) {
      violations.push(`releaseScope.managedTerminalProviders includes unknown or uncertified provider ${provider}`)
    }
  }
  for (const provider of duplicates(manifest.releaseScope?.managedTerminalProviders ?? [])) {
    violations.push(`releaseScope.managedTerminalProviders has duplicate provider ${provider}`)
  }

  const required = manifest.certification.productionGate.requiredCertifiedProviders ?? []
  if (required.length === 0) {
    violations.push('certification.productionGate.requiredCertifiedProviders must not be empty')
  }
  for (const provider of duplicates(required)) {
    violations.push(`requiredCertifiedProviders has duplicate provider ${provider}`)
  }
  for (const provider of required) {
    if (!byProvider.has(provider)) violations.push(`requiredCertifiedProviders references unknown provider ${provider}`)
  }
  for (const row of manifest.providers) {
    if ((row.managedEnabled || row.certificationState === PENDING_LIVE_PROVIDER_CERTIFICATION)
      && !required.includes(row.provider)) {
      violations.push(`requiredCertifiedProviders omits managed or pending provider ${row.provider}`)
    }
  }
  const deferrable = manifest.certification.landingGate.deferrableProviders ?? []
  for (const provider of duplicates(deferrable)) {
    violations.push(`deferrableProviders has duplicate provider ${provider}`)
  }
  for (const provider of deferrable) {
    if (byProvider.get(provider)?.certificationState !== PENDING_LIVE_PROVIDER_CERTIFICATION) {
      violations.push(`deferrableProviders includes non-pending provider ${provider}`)
    }
  }
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
      if (!byProvider.has(provider)) {
        violations.push(`doorway ${doorway.id} routes unknown provider ${provider} as managed`)
      }
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
  /** The exact manifest-expanded case set, including evidence audit cases. */
  expectedCaseIds?: readonly string[]
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
  if (input.cleanupOk !== true) failures.push('cleanup did not verify')
  if (!Number.isSafeInteger(input.unsafeBrokerAttempts) || input.unsafeBrokerAttempts < 0) {
    failures.push('unsafe destructive broker attempt count is invalid')
  }
  if (input.unsafeBrokerAttempts > 0) {
    failures.push(`${input.unsafeBrokerAttempts} unsafe destructive broker attempt(s)`)
  }
  for (const provider of deferred) {
    if (!deferrable.has(provider)) {
      failures.push(`provider ${provider} may not be deferred`)
    }
  }

  const actualCaseIds = input.caseResults.map((row) => row.caseId)
  if (actualCaseIds.length === 0) failures.push('no cases executed')
  for (const caseId of duplicates(actualCaseIds)) failures.push(`duplicate case result: ${caseId}`)
  if (input.expectedCaseIds !== undefined) {
    if (input.expectedCaseIds.length === 0) failures.push('required case set is empty')
    for (const caseId of duplicates(input.expectedCaseIds)) failures.push(`duplicate required case: ${caseId}`)
    const expected = new Set(input.expectedCaseIds)
    const actual = new Set(actualCaseIds)
    for (const caseId of expected) {
      if (!actual.has(caseId)) failures.push(`missing required case: ${caseId}`)
    }
    for (const caseId of actual) {
      if (!expected.has(caseId)) failures.push(`unexpected case result: ${caseId}`)
    }
  }
  for (const provider of duplicates(deferred)) failures.push(`duplicate deferred provider: ${provider}`)
  // Every declared deferral needs its own terminal result. A pending list
  // alone must never turn an all-PASS production summary into certification.
  for (const provider of deferred) {
    const row = input.caseResults.find((result) => result.caseId === providerCertificationCaseId(provider))
    const accounted = input.mode === 'landing'
      ? row?.status === DEFERRED_CASE_STATUS
      : row?.status === 'BLOCKED' && row.reason === PENDING_LIVE_PROVIDER_CERTIFICATION
    if (!accounted) failures.push(`deferred provider ${provider} has no matching ${input.mode} result`)
  }

  const blocked: string[] = []
  for (const result of input.caseResults) {
    if (typeof result.caseId !== 'string' || result.caseId.trim().length === 0) {
      failures.push('case result has no valid case ID')
    }
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
      }
      // Only PC-<PROVIDER> is deferrable. A phase/soak/safety case cannot
      // borrow an allowed provider field or omit it to bypass this boundary.
      const provider = [...deferrable].find((name) => providerCertificationCaseId(name) === result.caseId)
      if (!provider || (result.provider !== undefined && result.provider !== provider)) {
        failures.push(`${result.caseId} is not an authorized provider certification deferral`)
      } else if (!deferred.includes(provider)) {
        failures.push(`${result.caseId} is missing from the deferred-provider manifest`)
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
