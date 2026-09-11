import fs from 'node:fs'

import path from 'node:path'

export type NativeProofStage = 'initial' | 'after_session_host_crash' | 'after_provider_process_crash'

export type ProviderIdentifiedMessageEvidence = {
  kind: 'identified_message'
  turnId: string
  messageId: string
  parentMessageId: string | null
}

export type ProviderAppendOnlyRecordEvidence = {
  kind: 'append_only_record'
  recordIndex: number
  byteStart: number
  byteEnd: number
  recordSha256: string
  prefixSha256Before: string
  completionEventOrdinal: number
  completionEventSha256: string
}

export type ProviderNativeEvidence = ProviderIdentifiedMessageEvidence | ProviderAppendOnlyRecordEvidence

export type ProviderNativeTurnProof = {
  schemaVersion: 2
  stage: NativeProofStage
  nativeSessionId: string
  nativeEvidence: ProviderNativeEvidence
  completedAt: string | number
  responseSha256: string
  responseContainsNonce: true
  toolCallCount: number
  toolCallTypes: string[]
  resolvedProvider: string
  resolvedModel: string
  resolvedReasoningEffort: string
  providerProvenance: string
  modelProvenance: string
  reasoningEffortProvenance: string
}

export type ProviderQualificationRow = {
  provider: string
  modes: string[]
  providerVersion: string
  model: string
  reasoningEffort: string
  nativeSessionId: string
  nonceSha256: string
  nativeTurnProofs: ProviderNativeTurnProof[]
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

function validateProviderRows(value: unknown): asserts value is ProviderQualificationRow[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('qualification assertion artifact must contain provider rows')
  }
  const seen = new Set<string>()
  for (const candidate of value) {
    const row = object(candidate, 'qualification provider row')
    assertEvidenceRedacted(row, 'qualification provider row')
    const provider = nonEmptyString(row.provider, 'provider')
    if (seen.has(provider)) throw new Error('qualification provider row is duplicated')
    seen.add(provider)
    if (!Array.isArray(row.modes) || row.modes.length === 0 || row.modes.some((mode: unknown) => typeof mode !== 'string' || !mode)) {
      throw new Error('qualification provider modes must contain exact non-empty values')
    }
    for (const field of ['providerVersion', 'model', 'reasoningEffort', 'nativeSessionId'] as const) {
      boundedEvidenceString(row[field], `${provider}.${field}`)
    }
    if (typeof row.nonceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.nonceSha256)) {
      throw new Error(`${provider}.nonceSha256 must be a SHA-256 digest`)
    }
    validateNativeTurnProofs(provider, row)
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
      if (row[field] !== true) throw new Error(`qualification provider field ${field} must be true in evidence`)
    }
    const limits = object(row.limitEvidence, `${provider}.limitEvidence`)
    for (const field of ['cpuMax', 'memoryMax', 'swapMax', 'pidsMax'] as const) {
      nonEmptyString(limits[field], `${provider}.limitEvidence.${field}`)
    }
    if (limits.swapMax !== '0') {
      throw new Error('qualification provider limitEvidence.swapMax must prove swap is disabled')
    }
    const claim = object(row.writerClaim, `${provider}.writerClaim`)
    stringEqual(claim.provider, provider, `${provider}.writerClaim.provider`)
    stringEqual(claim.nativeSessionId, row.nativeSessionId, `${provider}.writerClaim.nativeSessionId`)
    for (const field of ['providerStoreId', 'soulId', 'incarnationId'] as const) {
      nonEmptyString(claim[field], `${provider}.writerClaim.${field}`)
    }
    if (claim.activeClaimCount !== 1 || claim.globalConflictingClaimCount !== 0) {
      throw new Error('qualification provider writerClaim must prove exactly one global tuple owner')
    }
    const ordering = object(row.verifiedEmptyOrdering, `${provider}.verifiedEmptyOrdering`)
    if (ordering.stopOutcome !== 'verified_empty'
      || ordering.activeClaimCountAfterStop !== 0
      || ordering.globalConflictingClaimCountAfterStop !== 0
      || ordering.oldContainerRunningAfterStop !== false) {
      throw new Error('qualification provider verifiedEmptyOrdering must prove claim release and enclosure emptiness after stop')
    }
    if (row.lostNoticeCount !== 0) {
      throw new Error('qualification provider lostNoticeCount must be zero in evidence')
    }
    const crashKinds = new Set(Array.isArray(row.crashKinds) ? row.crashKinds : [])
    for (const required of ['session_host', 'provider_process']) {
      if (!crashKinds.has(required)) throw new Error(`qualification crashKinds must include ${required}`)
    }
  }
}

const REQUIRED_NATIVE_STAGES: readonly NativeProofStage[] = [
  'initial',
  'after_session_host_crash',
  'after_provider_process_crash',
]

function validateNativeTurnProofs(provider: string, row: Record<string, any>): void {
  if (!Array.isArray(row.nativeTurnProofs) || row.nativeTurnProofs.length !== REQUIRED_NATIVE_STAGES.length) {
    throw new Error(`${provider}.nativeTurnProofs must contain exactly the three required stages`)
  }
  const messageIds = new Set<string>()
  const turnIds = new Set<string>()
  const recordDigests = new Set<string>()
  const completionDigests = new Set<string>()
  let priorCompletion = -Infinity
  let priorRecordIndex = -1
  let priorByteEnd = -1
  let priorCompletionOrdinal = 0
  for (const [index, candidate] of row.nativeTurnProofs.entries()) {
    const proof = object(candidate, `${provider}.nativeTurnProofs[${index}]`)
    if (proof.schemaVersion !== 2) throw new Error(`${provider}.nativeTurnProofs[${index}] has an unsupported schema`)
    if (proof.stage !== REQUIRED_NATIVE_STAGES[index]) {
      throw new Error(`${provider}.nativeTurnProofs must contain the required stages in chronological order`)
    }
    stringEqual(proof.nativeSessionId, row.nativeSessionId, `${provider}.nativeTurnProofs[${index}].nativeSessionId`)
    const evidence = object(proof.nativeEvidence, `${provider}.nativeTurnProofs[${index}].nativeEvidence`)
    if (provider === 'amplifier') {
      if (evidence.kind !== 'append_only_record') {
        throw new Error('Amplifier qualification requires native append-only record evidence, not fabricated message ids')
      }
      const integer = (value: unknown, label: string, minimum: number): number => {
        if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be a bounded integer`)
        return value as number
      }
      const recordIndex = integer(evidence.recordIndex, `${provider}.nativeTurnProofs[${index}].recordIndex`, 0)
      const byteStart = integer(evidence.byteStart, `${provider}.nativeTurnProofs[${index}].byteStart`, 0)
      const byteEnd = integer(evidence.byteEnd, `${provider}.nativeTurnProofs[${index}].byteEnd`, 1)
      const completionOrdinal = integer(evidence.completionEventOrdinal, `${provider}.nativeTurnProofs[${index}].completionEventOrdinal`, 1)
      if (byteEnd <= byteStart) throw new Error(`${provider}.nativeTurnProofs[${index}] has an invalid native append byte range`)
      if (recordIndex <= priorRecordIndex || byteStart <= priorByteEnd || completionOrdinal <= priorCompletionOrdinal) {
        throw new Error(`${provider}.nativeTurnProofs must prove strictly increasing native append and completion positions`)
      }
      for (const field of ['recordSha256', 'prefixSha256Before', 'completionEventSha256'] as const) {
        if (typeof evidence[field] !== 'string' || !/^[a-f0-9]{64}$/.test(evidence[field])) {
          throw new Error(`${provider}.nativeTurnProofs[${index}].${field} must be a SHA-256 digest`)
        }
      }
      if (recordDigests.has(evidence.recordSha256) || completionDigests.has(evidence.completionEventSha256)) {
        throw new Error(`${provider}.nativeTurnProofs must identify distinct native append/completion records`)
      }
      recordDigests.add(evidence.recordSha256)
      completionDigests.add(evidence.completionEventSha256)
      priorRecordIndex = recordIndex
      priorByteEnd = byteEnd
      priorCompletionOrdinal = completionOrdinal
    } else {
      if (evidence.kind !== 'identified_message') {
        throw new Error(`${provider}.nativeTurnProofs require provider-native identified-message evidence`)
      }
      const turnId = boundedEvidenceId(evidence.turnId, `${provider}.nativeTurnProofs[${index}].turnId`)
      const messageId = boundedEvidenceId(evidence.messageId, `${provider}.nativeTurnProofs[${index}].messageId`)
      if (turnIds.has(turnId)) throw new Error(`${provider}.nativeTurnProofs must use distinct native turn ids`)
      if (messageIds.has(messageId)) throw new Error(`${provider}.nativeTurnProofs must use distinct native assistant message ids`)
      turnIds.add(turnId)
      messageIds.add(messageId)
      if (evidence.parentMessageId !== null) {
        boundedEvidenceId(evidence.parentMessageId, `${provider}.nativeTurnProofs[${index}].parentMessageId`)
      }
    }
    const completedAt = nativeCompletionMillis(proof.completedAt, `${provider}.nativeTurnProofs[${index}].completedAt`)
    if (completedAt <= priorCompletion) throw new Error(`${provider}.nativeTurnProofs completion timestamps must increase`)
    priorCompletion = completedAt
    if (typeof proof.responseSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.responseSha256)) {
      throw new Error(`${provider}.nativeTurnProofs[${index}] must include a response SHA-256 digest`)
    }
    if (proof.responseContainsNonce !== true) {
      throw new Error(`${provider}.nativeTurnProofs[${index}] must prove native response nonce containment`)
    }
    if (proof.toolCallCount !== 0 || !Array.isArray(proof.toolCallTypes) || proof.toolCallTypes.length !== 0) {
      throw new Error(`${provider}.nativeTurnProofs[${index}] must prove zero native tool calls`)
    }
    for (const field of [
      'resolvedProvider',
      'resolvedModel',
      'resolvedReasoningEffort',
      'providerProvenance',
      'modelProvenance',
      'reasoningEffortProvenance',
    ] as const) boundedEvidenceString(proof[field], `${provider}.nativeTurnProofs[${index}].${field}`)
    for (const field of ['providerProvenance', 'modelProvenance', 'reasoningEffortProvenance'] as const) {
      if (/(?:process|argv|command)[-_ ]?(?:args?|line)?|launch[-_ ]?policy|picker|configured[-_ ]?value/i.test(proof[field])) {
        throw new Error(`${provider}.nativeTurnProofs[${index}].${field} is not native provenance`)
      }
    }
    validateNativeProfile(provider, row, proof, index)
  }
}

function validateNativeProfile(provider: string, row: Record<string, any>, proof: Record<string, any>, index: number): void {
  const label = `${provider}.nativeTurnProofs[${index}]`
  if (proof.resolvedReasoningEffort !== row.reasoningEffort) {
    throw new Error(`${label} native reasoning effort does not match the qualified profile`)
  }
  if (provider === 'claude') {
    if (proof.resolvedProvider !== 'anthropic' || !String(proof.resolvedModel).toLowerCase().includes('haiku')
      || !String(row.model).toLowerCase().includes('haiku')) {
      throw new Error(`${label} does not prove the native Claude Haiku profile`)
    }
    return
  }
  if (provider === 'codex') {
    if (proof.resolvedProvider !== 'openai' || proof.resolvedModel !== row.model) {
      throw new Error(`${label} does not prove the native Codex model profile`)
    }
    return
  }
  if (provider === 'opencode') {
    const qualified = proof.resolvedModel.includes('/')
      ? proof.resolvedModel
      : `${proof.resolvedProvider}/${proof.resolvedModel}`
    if (qualified !== row.model) throw new Error(`${label} does not prove the native OpenCode model profile`)
    return
  }
  if (provider === 'amplifier') {
    if (proof.resolvedProvider !== 'lunaroute' || proof.resolvedModel !== row.model) {
      throw new Error(`${label} does not prove the approved native Amplifier OneCLI profile`)
    }
    return
  }
  throw new Error(`${provider} has no native profile validation contract`)
}

function nativeCompletionMillis(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new Error(`${label} must be a positive epoch millisecond or timestamp`)
}

const FORBIDDEN_EVIDENCE_KEYS = new Set([
  'nonce', 'prompt', 'prompttext', 'rawprompt', 'response', 'responsetext', 'rawresponse',
  'authorization', 'cookie', 'credentials', 'apikey', 'accesstoken', 'refreshtoken', 'password',
])

const SECRET_VALUE_PATTERN = /(?:\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}|\bAIza[A-Za-z0-9_-]{8,})/i

function assertEvidenceRedacted(value: unknown, label: string): void {
  const visit = (candidate: unknown, trail: string): void => {
    if (typeof candidate === 'string') {
      if (SECRET_VALUE_PATTERN.test(candidate)) throw new Error(`${label} contains an unredacted synthetic-secret pattern at ${trail}`)
      return
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${trail}[${index}]`))
      return
    }
    if (!candidate || typeof candidate !== 'object') return
    for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
      const normalized = key.toLowerCase().replace(/[^a-z]/g, '')
      if (FORBIDDEN_EVIDENCE_KEYS.has(normalized)) {
        throw new Error(`${label} must redact forbidden evidence field ${key}`)
      }
      visit(item, `${trail}.${key}`)
    }
  }
  visit(value, label)
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

function boundedEvidenceString(value: unknown, label: string): string {
  const result = nonEmptyString(value, label)
  if (result.length > 256) throw new Error(`${label} exceeds the retained evidence bound`)
  return result
}

function boundedEvidenceId(value: unknown, label: string): string {
  const result = boundedEvidenceString(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(result)) {
    throw new Error(`${label} is not a bounded native identifier`)
  }
  return result
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
/** Assert observations in the test that made them; no imported certificate. */
export function assertProviderResults(repoRoot: string, rows: unknown): asserts rows is ProviderQualificationRow[] {
  validateProviderRows(rows)
  assertPinnedProviderVersions(repoRoot, rows)
}
