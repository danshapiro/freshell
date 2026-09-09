import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const PROVIDER_QUALIFICATION_ASSERTIONS_FILE = 'provider-qualification-assertions.json'
export const PROVIDER_QUALIFICATION_BROKER_FILE = 'broker.jsonl'
export const PROVIDER_QUALIFICATION_CLEANUP_FILE = 'cleanup.json'

export type ProviderQualificationRow = {
  provider: string
  modes: string[]
  providerVersion: string
  model: string
  reasoningEffort: string
  nativeSessionId: string
  actualProviderBinary: boolean
  completedTurn: boolean
  nativeStateCaptured: boolean
  runtimeOwned: boolean
  limitsVerified: boolean
  swapMaxVerified: boolean
  limitEvidence: {
    cpuMax: string
    memoryMax: string
    swapMax: string
    pidsMax: string
  }
  automaticResume: boolean
  profileVerified: boolean
  releaseBinary: boolean
  nativeRecovery: boolean
  exactNativeRecovery: boolean
  sameNativeSession: boolean
  followUpCompleted: boolean
  onlyOneWriter: boolean
  writerClaim: {
    provider: string
    providerStoreId: string
    nativeSessionId: string
    soulId: string
    incarnationId: string
    activeClaimCount: number
    globalConflictingClaimCount: number
  }
  oldEnclosureVerifiedEmpty: boolean
  verifiedEmptyOrdering: {
    stopOutcome: 'verified_empty'
    activeClaimCountAfterStop: number
    globalConflictingClaimCountAfterStop: number
    oldContainerRunningAfterStop: boolean
  }
  lostNoticeCount: number
  crashKinds: string[]
  [key: string]: unknown
}

export type QualificationArtifactReference = {
  path: string
  sha256: string
}

export type ProviderQualificationBuildEvidence = {
  kind: 'production' | 'qualification_fixture'
  serverFeatures: string[]
  supervisorFeatures: string[]
  qualificationProviders: string[]
  binaries: {
    server: { path: string, sha256: string, bytes: number }
    supervisor: { path: string, sha256: string, bytes: number }
  }
}

export type ProviderQualificationReceiptV2 = {
  schemaVersion: 2
  status: 'PASS'
  candidateSha: string
  receiptRunId: string
  evidenceRun: string
  runtimeImage: string
  qualificationBuild: ProviderQualificationBuildEvidence
  providers: ProviderQualificationRow[]
  artifacts: {
    assertions: QualificationArtifactReference
    broker: QualificationArtifactReference
    cleanup: QualificationArtifactReference
  }
}

export type BuildProviderQualificationReceiptInput = {
  repoRoot: string
  evidenceDir: string
  candidateSha: string
  receiptRunId: string
  runtimeImage: string
  providers: ProviderQualificationRow[]
}

export type ValidateProviderQualificationReceiptInput = {
  repoRoot: string
  candidateSha: string
  expectedRuntimeImage: string
  receipt: unknown
  allowLegacyV1ForProviders?: readonly string[]
  /** Preliminary evidence consumers must opt in explicitly; final gates omit this. */
  acceptedBuildKinds?: readonly ProviderQualificationBuildEvidence['kind'][]
}

export type ValidatedProviderQualificationReceipt = {
  schemaVersion: 1 | 2
  legacyV1: boolean
  providers: any[]
  receipt: any
}

/**
 * Finalize a qualification only after RuntimeHarness.cleanup() has emitted its
 * exact cleanup record. The receipt is an index over hashed run evidence; it
 * is not itself the authority for cleanup, broker safety, or provider facts.
 */
export function buildProviderQualificationReceipt(
  input: BuildProviderQualificationReceiptInput,
): ProviderQualificationReceiptV2 {
  const repoRoot = fs.realpathSync(input.repoRoot)
  const evidenceRun = expectedEvidenceRun(input.candidateSha, input.receiptRunId)
  const expectedDir = path.join(repoRoot, ...evidenceRun.split('/'))
  if (fs.realpathSync(input.evidenceDir) !== expectedDir) {
    throw new Error(`qualification evidence directory must be the candidate-bound run ${evidenceRun}`)
  }
  const qualificationBuild = assertCandidateAndImageArtifacts(
    expectedDir,
    input.candidateSha,
    input.receiptRunId,
    input.runtimeImage,
  )
  validateProviderRows(input.providers)
  assertQualificationProviderSelection(qualificationBuild, input.providers)
  assertPinnedProviderVersions(repoRoot, input.providers)
  assertBrokerSafe(path.join(expectedDir, PROVIDER_QUALIFICATION_BROKER_FILE))
  assertCleanupOk(path.join(expectedDir, PROVIDER_QUALIFICATION_CLEANUP_FILE))

  const assertionsPath = path.join(expectedDir, PROVIDER_QUALIFICATION_ASSERTIONS_FILE)
  fs.writeFileSync(assertionsPath, JSON.stringify({
    schemaVersion: 1,
    candidateSha: input.candidateSha,
    receiptRunId: input.receiptRunId,
    runtimeImage: input.runtimeImage,
    qualificationBuild,
    providers: input.providers,
  }, null, 2))

  const artifact = (fileName: string): QualificationArtifactReference => ({
    path: `${evidenceRun}/${fileName}`,
    sha256: sha256File(path.join(expectedDir, fileName)),
  })
  const receipt: ProviderQualificationReceiptV2 = {
    schemaVersion: 2,
    status: 'PASS',
    candidateSha: input.candidateSha,
    receiptRunId: input.receiptRunId,
    evidenceRun,
    runtimeImage: input.runtimeImage,
    qualificationBuild,
    providers: input.providers,
    artifacts: {
      assertions: artifact(PROVIDER_QUALIFICATION_ASSERTIONS_FILE),
      broker: artifact(PROVIDER_QUALIFICATION_BROKER_FILE),
      cleanup: artifact(PROVIDER_QUALIFICATION_CLEANUP_FILE),
    },
  }
  validateProviderQualificationReceipt({
    repoRoot,
    candidateSha: input.candidateSha,
    expectedRuntimeImage: input.runtimeImage,
    receipt,
    acceptedBuildKinds: [qualificationBuild.kind],
  })
  return receipt
}

/**
 * Validate a supplied receipt against the original candidate-bound evidence
 * directory. Schema v1 is a narrow migration exception and can never certify
 * a provider outside the caller's explicit allowlist.
 */
export function validateProviderQualificationReceipt(
  input: ValidateProviderQualificationReceiptInput,
): ValidatedProviderQualificationReceipt {
  const receipt = object(input.receipt, 'provider qualification receipt')
  if (receipt.schemaVersion === 1) {
    return validateLegacyV1(input, receipt)
  }
  if (receipt.schemaVersion !== 2) {
    throw new Error('provider qualification receipt must use schema v2')
  }
  if (receipt.status !== 'PASS') throw new Error('provider qualification receipt status is not PASS')
  stringEqual(receipt.candidateSha, input.candidateSha, 'receipt candidate SHA')
  nonEmptyString(receipt.receiptRunId, 'receiptRunId')
  nonEmptyString(receipt.runtimeImage, 'runtimeImage')
  stringEqual(receipt.runtimeImage, input.expectedRuntimeImage, 'receipt runtime image')

  const evidenceRun = expectedEvidenceRun(input.candidateSha, receipt.receiptRunId)
  stringEqual(receipt.evidenceRun, evidenceRun, 'receipt evidence run')
  const repoRoot = fs.realpathSync(input.repoRoot)
  const evidenceDir = path.join(repoRoot, ...evidenceRun.split('/'))
  if (!fs.existsSync(evidenceDir)) throw new Error(`qualification evidence run is missing: ${evidenceRun}`)
  if (fs.realpathSync(evidenceDir) !== evidenceDir) {
    throw new Error(`qualification evidence run must not traverse a symlink: ${evidenceRun}`)
  }
  const qualificationBuild = assertCandidateAndImageArtifacts(
    evidenceDir,
    input.candidateSha,
    receipt.receiptRunId,
    input.expectedRuntimeImage,
  )
  const acceptedBuildKinds = new Set(input.acceptedBuildKinds ?? ['production'])
  if (!acceptedBuildKinds.has(qualificationBuild.kind)) {
    throw new Error(`qualification ${qualificationBuild.kind} build cannot satisfy this production receipt gate`)
  }
  if (stableJson(receipt.qualificationBuild) !== stableJson(qualificationBuild)) {
    throw new Error('receipt qualification build differs from the candidate-bound build artifact')
  }

  const artifacts = object(receipt.artifacts, 'receipt artifacts')
  const assertionsBytes = validateArtifact(
    evidenceDir,
    evidenceRun,
    PROVIDER_QUALIFICATION_ASSERTIONS_FILE,
    artifacts.assertions,
  )
  const brokerBytes = validateArtifact(
    evidenceDir,
    evidenceRun,
    PROVIDER_QUALIFICATION_BROKER_FILE,
    artifacts.broker,
  )
  const cleanupBytes = validateArtifact(
    evidenceDir,
    evidenceRun,
    PROVIDER_QUALIFICATION_CLEANUP_FILE,
    artifacts.cleanup,
  )

  const assertions = parseJsonObject(assertionsBytes, 'qualification assertion artifact')
  if (assertions.schemaVersion !== 1) throw new Error('qualification assertion artifact has an unsupported schema')
  stringEqual(assertions.candidateSha, input.candidateSha, 'assertion artifact candidate SHA')
  stringEqual(assertions.receiptRunId, receipt.receiptRunId, 'assertion artifact run id')
  stringEqual(assertions.runtimeImage, input.expectedRuntimeImage, 'assertion artifact runtime image')
  if (stableJson(assertions.qualificationBuild) !== stableJson(qualificationBuild)) {
    throw new Error('qualification assertion build differs from the candidate-bound build artifact')
  }
  if (stableJson(assertions.providers) !== stableJson(receipt.providers)) {
    throw new Error('receipt provider summary differs from the hashed assertion artifact')
  }
  validateProviderRows(assertions.providers)
  assertQualificationProviderSelection(qualificationBuild, assertions.providers)
  assertPinnedProviderVersions(repoRoot, assertions.providers)
  assertBrokerSafeBytes(brokerBytes)
  assertCleanupOkBytes(cleanupBytes)
  return {
    schemaVersion: 2,
    legacyV1: false,
    providers: assertions.providers,
    receipt,
  }
}

function validateLegacyV1(
  input: ValidateProviderQualificationReceiptInput,
  receipt: Record<string, any>,
): ValidatedProviderQualificationReceipt {
  if (receipt.status !== 'PASS') throw new Error('legacy provider qualification receipt is not PASS')
  stringEqual(receipt.candidateSha, input.candidateSha, 'legacy receipt candidate SHA')
  stringEqual(receipt.runtimeImage, input.expectedRuntimeImage, 'legacy receipt runtime image')
  const providers = Array.isArray(receipt.providers) ? receipt.providers : []
  if (providers.length === 0) throw new Error('legacy provider qualification receipt has no provider rows')
  const allowed = new Set(input.allowLegacyV1ForProviders ?? [])
  const forbidden = providers
    .map((row) => row?.provider)
    .filter((provider) => typeof provider !== 'string' || !allowed.has(provider))
  if (forbidden.length) {
    throw new Error(`legacy schema v1 cannot certify ${forbidden.join(', ')}; production promotion requires schema v2`)
  }
  return { schemaVersion: 1, legacyV1: true, providers, receipt }
}

function validateProviderRows(value: unknown): asserts value is ProviderQualificationRow[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('qualification assertion artifact must contain provider rows')
  }
  const seen = new Set<string>()
  for (const candidate of value) {
    const row = object(candidate, 'qualification provider row')
    const provider = nonEmptyString(row.provider, 'provider')
    if (seen.has(provider)) throw new Error(`qualification provider row ${provider} is duplicated`)
    seen.add(provider)
    if (!Array.isArray(row.modes) || row.modes.length === 0 || row.modes.some((mode: unknown) => typeof mode !== 'string' || !mode)) {
      throw new Error(`${provider}.modes must contain exact provider modes`)
    }
    for (const field of ['providerVersion', 'model', 'reasoningEffort', 'nativeSessionId'] as const) {
      nonEmptyString(row[field], `${provider}.${field}`)
    }
    for (const field of [
      'actualProviderBinary',
      'completedTurn',
      'nativeStateCaptured',
      'runtimeOwned',
      'limitsVerified',
      'swapMaxVerified',
      'automaticResume',
      'profileVerified',
      'releaseBinary',
      'nativeRecovery',
      'exactNativeRecovery',
      'sameNativeSession',
      'followUpCompleted',
      'onlyOneWriter',
      'oldEnclosureVerifiedEmpty',
    ] as const) {
      if (row[field] !== true) throw new Error(`${provider}.${field} must be true in qualification evidence`)
    }
    const limits = object(row.limitEvidence, `${provider}.limitEvidence`)
    for (const field of ['cpuMax', 'memoryMax', 'swapMax', 'pidsMax'] as const) {
      nonEmptyString(limits[field], `${provider}.limitEvidence.${field}`)
    }
    if (limits.swapMax !== '0') {
      throw new Error(`${provider}.limitEvidence.swapMax must prove swap is disabled`)
    }
    const claim = object(row.writerClaim, `${provider}.writerClaim`)
    stringEqual(claim.provider, provider, `${provider}.writerClaim.provider`)
    stringEqual(claim.nativeSessionId, row.nativeSessionId, `${provider}.writerClaim.nativeSessionId`)
    for (const field of ['providerStoreId', 'soulId', 'incarnationId'] as const) {
      nonEmptyString(claim[field], `${provider}.writerClaim.${field}`)
    }
    if (claim.activeClaimCount !== 1 || claim.globalConflictingClaimCount !== 0) {
      throw new Error(`${provider}.writerClaim must prove exactly one global tuple owner`)
    }
    const ordering = object(row.verifiedEmptyOrdering, `${provider}.verifiedEmptyOrdering`)
    if (ordering.stopOutcome !== 'verified_empty'
      || ordering.activeClaimCountAfterStop !== 0
      || ordering.globalConflictingClaimCountAfterStop !== 0
      || ordering.oldContainerRunningAfterStop !== false) {
      throw new Error(`${provider}.verifiedEmptyOrdering must prove claim release and enclosure emptiness after stop`)
    }
    if (row.lostNoticeCount !== 0) {
      throw new Error(`${provider}.lostNoticeCount must be zero in qualification evidence`)
    }
    const crashKinds = new Set(Array.isArray(row.crashKinds) ? row.crashKinds : [])
    for (const required of ['session_host', 'provider_process']) {
      if (!crashKinds.has(required)) throw new Error(`${provider}.crashKinds must include ${required}`)
    }
  }
}

function assertCandidateAndImageArtifacts(
  evidenceDir: string,
  candidateSha: string,
  receiptRunId: string,
  runtimeImage: string,
): ProviderQualificationBuildEvidence {
  const manifest = readJsonObject(path.join(evidenceDir, 'manifest.json'), 'run manifest')
  const execution = object(manifest.execution, 'run manifest execution')
  stringEqual(execution.candidateSha, candidateSha, 'run manifest candidate SHA')
  stringEqual(execution.runId, receiptRunId, 'run manifest run id')
  const build = readJsonObject(path.join(evidenceDir, 'build.json'), 'run build artifact')
  stringEqual(build.candidateSha, candidateSha, 'build artifact candidate SHA')
  stringEqual(build.runtimeImage, runtimeImage, 'build artifact runtime image')
  return validateQualificationBuild(build.qualificationBuild)
}

function validateQualificationBuild(value: unknown): ProviderQualificationBuildEvidence {
  const build = object(value, 'qualification build evidence')
  if (build.kind !== 'production' && build.kind !== 'qualification_fixture') {
    throw new Error('qualification build kind must be production or qualification_fixture')
  }
  const stringArray = (candidate: unknown, label: string): string[] => {
    if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== 'string' || !item)) {
      throw new Error(`${label} must be an array of non-empty strings`)
    }
    if (new Set(candidate).size !== candidate.length) throw new Error(`${label} must not contain duplicates`)
    return candidate
  }
  const serverFeatures = stringArray(build.serverFeatures, 'qualification server features')
  const supervisorFeatures = stringArray(build.supervisorFeatures, 'qualification supervisor features')
  const qualificationProviders = stringArray(build.qualificationProviders, 'qualification providers')
  const binaries = object(build.binaries, 'qualification binaries')
  const validateBinary = (candidate: unknown, label: string) => {
    const binary = object(candidate, label)
    nonEmptyString(binary.path, `${label} path`)
    if (typeof binary.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binary.sha256)) {
      throw new Error(`${label} must include a SHA-256 digest`)
    }
    if (!Number.isSafeInteger(binary.bytes) || binary.bytes <= 0) {
      throw new Error(`${label} must include a positive byte size`)
    }
    return binary as ProviderQualificationBuildEvidence['binaries']['server']
  }
  const result: ProviderQualificationBuildEvidence = {
    kind: build.kind,
    serverFeatures,
    supervisorFeatures,
    qualificationProviders,
    binaries: {
      server: validateBinary(binaries.server, 'qualification server binary'),
      supervisor: validateBinary(binaries.supervisor, 'qualification supervisor binary'),
    },
  }
  if (result.kind === 'production') {
    if (qualificationProviders.length !== 0
      || stableJson([...serverFeatures].sort()) !== stableJson(['managed-runtime-v1'])
      || supervisorFeatures.length !== 0) {
      throw new Error('production qualification build must use only managed-runtime-v1 with no qualification policy')
    }
  } else {
    const allowedPending = new Set(['claude', 'codex', 'amplifier'])
    if (qualificationProviders.length === 0
      || qualificationProviders.some((provider) => !allowedPending.has(provider))
      || stableJson([...serverFeatures].sort()) !== stableJson(['managed-provider-qualification'])
      || stableJson([...supervisorFeatures].sort()) !== stableJson(['provider-qualification'])) {
      throw new Error('qualification fixture must pin its feature set and selected providers')
    }
  }
  return result
}

function assertQualificationProviderSelection(
  build: ProviderQualificationBuildEvidence,
  providers: ProviderQualificationRow[],
): void {
  if (build.kind !== 'qualification_fixture') return
  const pending = new Set(['claude', 'codex', 'amplifier'])
  const rows = providers
    .map((row) => row.provider)
    .filter((provider) => pending.has(provider))
    .sort()
  const selected = [...build.qualificationProviders].sort()
  if (stableJson(rows) !== stableJson(selected)) {
    throw new Error('qualification fixture provider rows must exactly match its pending-provider allowlist')
  }
}

function assertPinnedProviderVersions(repoRoot: string, providers: ProviderQualificationRow[]): void {
  const manifest = readJsonObject(
    path.join(repoRoot, 'docker/runtime/provider-versions.json'),
    'pinned provider version manifest',
  )
  const pinnedProviders = object(manifest.providers, 'pinned provider versions')
  for (const row of providers) {
    const pinned = object(pinnedProviders[row.provider], `pinned provider ${row.provider}`)
    stringEqual(row.providerVersion, nonEmptyString(pinned.version, `${row.provider} pinned version`), `${row.provider}.providerVersion`)
  }
}

function assertBrokerSafe(brokerPath: string): void {
  assertBrokerSafeBytes(readRegularFile(brokerPath, 'broker artifact'))
}

function assertBrokerSafeBytes(bytes: Buffer): void {
  const raw = bytes.toString('utf8')
  const lines = raw.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length === 0) throw new Error('broker artifact contains no broker events')
  let unsafe = 0
  for (const [index, line] of lines.entries()) {
    let event: any
    try {
      event = JSON.parse(line)
    } catch (error) {
      throw new Error(`broker artifact line ${index + 1} is not JSON: ${String(error)}`)
    }
    if (event?.unsafeAttempt === true) unsafe += 1
  }
  if (unsafe !== 0) throw new Error(`broker artifact records ${unsafe} unsafe attempt(s)`)
}

function assertCleanupOk(cleanupPath: string): void {
  assertCleanupOkBytes(readRegularFile(cleanupPath, 'cleanup artifact'))
}

function assertCleanupOkBytes(bytes: Buffer): void {
  const cleanup = parseJsonObject(bytes, 'cleanup artifact')
  const errors = Array.isArray(cleanup.errors) ? cleanup.errors : null
  const unsafe = Array.isArray(cleanup.unsafeBrokerAttempts) ? cleanup.unsafeBrokerAttempts : null
  if (cleanup.ok !== true || !errors || errors.length !== 0) {
    throw new Error('cleanup artifact does not verify exact cleanup')
  }
  if (!unsafe || unsafe.length !== 0) {
    throw new Error('cleanup artifact records unsafe broker attempts')
  }
}

function validateArtifact(
  evidenceDir: string,
  evidenceRun: string,
  fileName: string,
  value: unknown,
): Buffer {
  const artifact = object(value, `${fileName} artifact reference`)
  const expectedPath = `${evidenceRun}/${fileName}`
  stringEqual(artifact.path, expectedPath, `${fileName} artifact path`)
  if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error(`${fileName} artifact has no valid SHA-256 digest`)
  }
  const filePath = path.join(evidenceDir, fileName)
  const bytes = readRegularFile(filePath, fileName)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== artifact.sha256) {
    throw new Error(`${fileName} artifact SHA-256 digest mismatch`)
  }
  return bytes
}

function expectedEvidenceRun(candidateSha: string, receiptRunId: string): string {
  if (!/^[a-f0-9]{40,64}$/.test(candidateSha)) throw new Error('candidate SHA is not a full hexadecimal commit id')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(receiptRunId)) {
    throw new Error('receipt run id is not a safe evidence directory name')
  }
  return `.runtime-evidence/${candidateSha}/${receiptRunId}`
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readRegularFile(filePath, path.basename(filePath))).digest('hex')
}

function readRegularFile(filePath: string, label: string): Buffer {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(filePath)
  } catch (error) {
    throw new Error(`${label} is missing: ${String(error)}`)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`)
  return fs.readFileSync(filePath)
}

function readJsonObject(filePath: string, label: string): Record<string, any> {
  return parseJsonObject(readRegularFile(filePath, label), label)
}

function parseJsonObject(bytes: Buffer, label: string): Record<string, any> {
  const raw = bytes.toString('utf8')
  try {
    return object(JSON.parse(raw), label)
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON: ${error.message}`)
    throw error
  }
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`)
  return value as Record<string, any>
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value
}

function stringEqual(actual: unknown, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label} does not match the candidate-bound evidence`)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
