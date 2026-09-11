import fs from 'node:fs'
import path from 'node:path'

import {
  array,
  digest,
  equalString,
  exactKeys,
  integer,
  loadPhase5Evidence,
  nonEmptyString,
  object,
  sha256,
  stableJson,
  validateCleanupContainsContainer,
  validateBrokerDestructiveTargets,
  validateTestCounts,
  type LoadedPhase5Evidence,
} from './runtime-phase5-evidence-common.js'

export const PHASE5_LOSS_ASSERTIONS_FILE = 'phase5-loss-assertions.json'
export const PHASE5_LOSS_INCIDENT_FILE = 'phase5-loss-incident.json'
export const PHASE5_CAPABILITY_INVENTORY_FILE = 'phase5-capability-inventory.json'

const ARTIFACT_FILES = {
  assertions: { fileName: PHASE5_LOSS_ASSERTIONS_FILE, format: 'json' },
  incident: { fileName: PHASE5_LOSS_INCIDENT_FILE, format: 'json' },
  lifecycle: { fileName: 'lifecycle.jsonl', format: 'jsonl' },
  broker: { fileName: 'broker.jsonl', format: 'jsonl' },
  cleanup: { fileName: 'cleanup.json', format: 'json' },
  build: { fileName: 'build.json', format: 'json' },
  manifest: { fileName: 'manifest.json', format: 'json' },
  capabilityInventory: { fileName: PHASE5_CAPABILITY_INVENTORY_FILE, format: 'json' },
} as const

export type Phase5LossSummary = {
  provider: string
  soulId: string
  incarnationId: string
  incidentId: string
  exactCleanupVerified: true
  displayedNoticeCount: 1
  foreignObjectsTouched: 0
}

export type ValidatedPhase5LossReceipt = LoadedPhase5Evidence & {
  summary: Phase5LossSummary
}

/**
 * Pure Phase 5 loss acceptance boundary. Receipt booleans are ignored until
 * the incident, monotonic lifecycle, capability inventory, broker, and exact
 * cleanup artifacts independently produce the same summary.
 */
export function assertPhase5LossRun(evidenceDir: string): ValidatedPhase5LossReceipt {
  const loaded = loadPhase5Evidence(evidenceDir, ARTIFACT_FILES)
  const assertions = loaded.json.assertions
  exactKeys(assertions, [
    'schemaVersion', 'caseId', 'candidateSha', 'receiptRunId', 'test',
    'identity', 'intent', 'providerState', 'browser',
  ], 'loss assertion artifact')
  if (assertions.schemaVersion !== 1 || assertions.caseId !== 'P5-G02') {
    throw new Error('loss assertion artifact has the wrong schema or case')
  }
  validateTestCounts(assertions.test, 'loss assertion test counts')

  const identity = validateIdentity(assertions.identity)
  const intent = object(assertions.intent, 'loss assertion intent')
  exactKeys(intent, ['checkedRevision', 'lossRevision', 'endedRevision'], 'loss assertion intent')
  const checkedRevision = integer(intent.checkedRevision, 'loss checked intent revision')
  if (intent.lossRevision !== checkedRevision || intent.endedRevision !== checkedRevision + 1) {
    throw new Error('loss was not bound to the exact checked intent revision')
  }
  validateProviderState(assertions.providerState)
  validateEndedPane(assertions.browser, identity)

  const capability = capabilityFor(loaded.json.capabilityInventory, identity.provider)
  const incident = validateIncident(loaded.json.incident, identity, capability, checkedRevision, { runtimeImage: loaded.json.build.runtimeImage })
  const displayedNoticeIds = object(assertions.browser, 'loss browser evidence').displayedNoticeIds
  if (displayedNoticeIds[0] !== loaded.json.incident.noticeId) {
    throw new Error('displayed loss notice does not match the durable incident notice')
  }
  validateLifecycle(loaded.jsonl.lifecycle, identity, incident.certificateSha256)
  validateBrokerDestructiveTargets(loaded.jsonl.broker, identity.containerId)
  validateCleanupContainsContainer(loaded.json.cleanup, identity.containerId)

  const summary: Phase5LossSummary = {
    provider: identity.provider,
    soulId: identity.soulId,
    incarnationId: identity.incarnationId,
    incidentId: identity.incidentId,
    exactCleanupVerified: true,
    displayedNoticeCount: 1,
    foreignObjectsTouched: 0,
  }
  return { ...loaded, summary }
}

function validateIdentity(value: unknown): {
  provider: string
  providerVersion: string
  soulId: string
  incarnationId: string
  containerId: string
  nativeSessionIdHash: string
  incidentId: string
} {
  const identity = object(value, 'loss identity')
  exactKeys(identity, [
    'provider', 'providerVersion', 'model', 'soulId', 'incarnationId',
    'containerId', 'hostBootId', 'nativeSessionIdHash', 'incidentId',
    'paneId', 'terminalId',
  ], 'loss identity')
  for (const key of [
    'provider', 'providerVersion', 'model', 'soulId', 'incarnationId',
    'hostBootId', 'incidentId', 'paneId', 'terminalId',
  ]) nonEmptyString(identity[key], `loss identity.${key}`)
  if (!/^[0-9a-f]{64}$/.test(identity.containerId)) throw new Error('loss identity.containerId is not an exact full container ID')
  if (typeof identity.nativeSessionIdHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(identity.nativeSessionIdHash)) {
    throw new Error('loss native identity must be retained only as a SHA-256 reference')
  }
  return identity as any
}

function validateProviderState(value: unknown): void {
  const state = object(value, 'loss provider-state evidence')
  exactKeys(state, ['exactAbsenceChecks', 'credentialIntegrity'], 'loss provider-state evidence')
  const checks = array(state.exactAbsenceChecks, 'loss exact absence checks')
  if (checks.length < 2) throw new Error('loss evidence must contain exact provider and checkpoint absence checks')
  const paths = new Set<string>()
  for (const candidate of checks) {
    const check = object(candidate, 'loss absence check')
    exactKeys(check, ['path', 'state', 'probe'], 'loss absence check')
    const checkedPath = nonEmptyString(check.path, 'loss absence check path')
    if (!checkedPath.startsWith('/home/freshell/provider/')) throw new Error('loss absence check escaped the isolated provider home')
    if (paths.has(checkedPath)) throw new Error('loss absence check path is duplicated')
    paths.add(checkedPath)
    if (check.state !== 'absent' || check.probe !== 'lstat') throw new Error('loss absence check is not a positive exact lstat absence')
  }
  if (![...paths].some((item) => item.endsWith('/opencode.db'))
    || ![...paths].some((item) => item.includes('/checkpoints'))) {
    throw new Error('loss evidence omits the exact native store or checkpoint location')
  }
  const credentials = array(state.credentialIntegrity, 'loss credential integrity')
  if (credentials.length === 0) throw new Error('loss evidence must hash the isolated credential reference before and after')
  for (const candidate of credentials) {
    const row = object(candidate, 'loss credential integrity row')
    exactKeys(row, [
      'path', 'beforeExists', 'afterExists', 'beforeSha256', 'afterSha256',
    ], 'loss credential integrity row')
    if (!nonEmptyString(row.path, 'credential path').startsWith('/home/freshell/provider/')) {
      throw new Error('credential integrity path escaped the isolated provider home')
    }
    if (typeof row.beforeExists !== 'boolean' || row.afterExists !== row.beforeExists) {
      throw new Error('credential existence changed during isolated loss induction')
    }
    digest(row.beforeSha256, 'credential before hash')
    digest(row.afterSha256, 'credential after hash')
    if (row.beforeSha256 !== row.afterSha256) throw new Error('credential bytes changed during isolated loss induction')
  }
}

function validateEndedPane(browserValue: unknown, identity: ReturnType<typeof validateIdentity>): void {
  const browser = object(browserValue, 'loss browser evidence')
  exactKeys(browser, ['displayedNoticeIds', 'endedPane'], 'loss browser evidence')
  const notices = array(browser.displayedNoticeIds, 'displayed notice ids')
  if (notices.length !== 1) throw new Error('loss browser evidence must display exactly one notice')
  const pane = object(browser.endedPane, 'ended pane evidence')
  exactKeys(pane, ['soulId', 'incarnationId', 'incidentId', 'nativeSessionIdHash', 'recoveryState'], 'ended pane evidence')
  for (const key of ['soulId', 'incarnationId', 'incidentId', 'nativeSessionIdHash'] as const) {
    if (pane[key] !== identity[key]) throw new Error(`ended pane does not retain exact ${key}`)
  }
  if (pane.recoveryState !== 'lost') throw new Error('ended pane is not retained in lost state')
}

function capabilityFor(inventory: Record<string, any>, provider: string): Record<string, any> {
  const rows = inventory.providers.filter((row: any) => row?.provider === provider)
  if (rows.length !== 1 || rows[0].managedEnabled !== true || rows[0].durableRecoveryEnabled !== true) {
    throw new Error(`checked-in capability inventory does not uniquely enable ${provider}`)
  }
  if (!Array.isArray(rows[0].recoveryPaths) || rows[0].recoveryPaths.length === 0) {
    throw new Error(`${provider} capability inventory has no recovery paths`)
  }
  return rows[0]
}

function validateIncident(
  value: Record<string, any>,
  identity: ReturnType<typeof validateIdentity>,
  capability: Record<string, any>,
  checkedRevision: number,
  input: { runtimeImage: string },
): { certificateSha256: string } {
  exactKeys(value, [
    'incidentId', 'event', 'certificate', 'certificateSha256', 'cleanupState',
    'cleanup', 'noticeId', 'updatedAt',
  ], 'loss incident artifact')
  equalString(value.incidentId, identity.incidentId, 'loss incident id')
  if (value.event !== 'soul.loss.finalized' || value.cleanupState !== 'closed') throw new Error('loss incident is not a closed final incident')
  const certificate = object(value.certificate, 'loss certificate')
  exactKeys(certificate, [
    'schemaVersion', 'event', 'incidentId', 'correlationId', 'installationId',
    'soulId', 'provider', 'providerStoreId', 'nativeSessionRefHash',
    'intentRevision', 'incarnations', 'builds', 'timeline', 'recoveryPaths',
    'decision', 'cleanupTarget', 'analysis', 'createdAt',
  ], 'loss certificate')
  if (certificate.schemaVersion !== 1 || certificate.event !== 'soul.loss.finalized') {
    throw new Error('loss certificate has an unsupported schema or event')
  }
  if (sha256(JSON.stringify(certificate)) !== value.certificateSha256) throw new Error('loss certificate hash mismatch')
  digest(value.certificateSha256, 'loss certificate hash')
  for (const key of ['incidentId', 'soulId', 'provider', 'nativeSessionRefHash'] as const) {
    const identityKey = key === 'nativeSessionRefHash' ? 'nativeSessionIdHash' : key
    if (certificate[key] !== identity[identityKey]) {
      throw new Error(`loss certificate identity mismatch for ${key}`)
    }
  }
  if (certificate.intentRevision !== checkedRevision) throw new Error('loss certificate uses a stale intent revision')
  if (stableJson(certificate.incarnations) !== stableJson([identity.incarnationId])) throw new Error('loss certificate targets anything but the exact incarnation')
  const builds = object(certificate.builds, 'loss certificate builds')
  exactKeys(builds, [
    'webCommit', 'supervisorCommit', 'hostImageDigest', 'providerVersion',
    'protocolVersion', 'registrySchemaVersion',
  ], 'loss certificate builds')
  equalString(builds.hostImageDigest, input.runtimeImage, 'loss host image')
  equalString(builds.providerVersion, identity.providerVersion, 'loss provider version')
  validateTimeline(certificate.timeline)
  const recoveryPaths = array(certificate.recoveryPaths, 'loss recovery paths')
  const expectedPaths = capability.recoveryPaths
  if (stableJson(recoveryPaths.map((row: any) => row?.path)) !== stableJson(expectedPaths)) {
    throw new Error('loss recovery evidence does not exactly match current capability inventory')
  }
  for (const candidate of recoveryPaths) {
    const row = object(candidate, 'loss recovery path')
    exactKeys(row, ['path', 'verdict', 'reasonCode', 'evidenceRefs', 'storeState'], 'loss recovery path')
    if (row.verdict !== 'definitive_negative') throw new Error(`loss recovery path ${row.path} is not definitive negative`)
    if (row.storeState === 'unknown' || row.storeState === 'present_unreadable') {
      throw new Error(`loss recovery path ${row.path} remains unknown or unreadable`)
    }
    if (row.reasonCode !== `${row.path}_definitive_negative_${row.storeState}`) {
      throw new Error(`loss recovery path ${row.path} does not use the structured definitive-negative reason code`)
    }
    if (!Array.isArray(row.evidenceRefs) || row.evidenceRefs.length !== 3
      || row.evidenceRefs[0] !== `recoveryPath=${row.path}`
      || row.evidenceRefs[1] !== `storeState=${row.storeState}`
      || !/^transientEvidenceDigest=sha256:[0-9a-f]{64}$/.test(row.evidenceRefs[2])) {
      throw new Error(`loss recovery path ${row.path} lacks normalized, non-content evidence references`)
    }
  }
  const decision = object(certificate.decision, 'loss decision')
  exactKeys(decision, ['state', 'reasonCode', 'unknownPaths', 'retainedRecoverableEvidence'], 'loss decision')
  if (decision.state !== 'lost' || decision.unknownPaths !== 0 || decision.retainedRecoverableEvidence !== false) {
    throw new Error('loss decision retains ambiguity or recoverable evidence')
  }
  const target = object(certificate.cleanupTarget, 'loss cleanup target')
  exactKeys(target, ['ownedHandleRef', 'ownershipVerified', 'incarnationId'], 'loss cleanup target')
  if (target.ownershipVerified !== true || target.incarnationId !== identity.incarnationId
    || !nonEmptyString(target.ownedHandleRef, 'owned handle reference').endsWith(`/incarnation/${identity.incarnationId}`)) {
    throw new Error('loss cleanup target is not the exact registry-owned incarnation')
  }
  const cleanup = object(value.cleanup, 'loss cleanup report')
  exactKeys(cleanup, [
    'ownedHandleRef', 'ownershipVerified', 'gracefulAttempt', 'forcedAttempt',
    'verifiedEmpty', 'verifiedAt', 'foreignObjectsTouched',
  ], 'loss cleanup report')
  if (cleanup.ownedHandleRef !== target.ownedHandleRef || cleanup.ownershipVerified !== true
    || cleanup.verifiedEmpty !== true || !nonEmptyString(cleanup.verifiedAt, 'loss verifiedAt')
    || cleanup.foreignObjectsTouched !== 0) {
    throw new Error('loss cleanup is not a positive exact-owned zero-foreign verification')
  }
  const analysis = object(certificate.analysis, 'loss incident analysis')
  const allowedAnalysis = ['observedCause', 'missingInvariant', 'hypotheses', 'preventiveAction', 'regressionCase']
  if (Object.keys(analysis).some(key => !allowedAnalysis.includes(key))) throw new Error('loss analysis contains an unknown field')
  equalString(analysis.observedCause, 'all_applicable_recovery_paths_definitively_unavailable', 'observed loss cause')
  return { certificateSha256: value.certificateSha256 }
}

function validateTimeline(value: unknown): void {
  const rows = array(value, 'incident timeline')
  if (rows.length === 0) throw new Error('incident timeline is empty')
  let priorAt = -1
  rows.forEach((candidate, index) => {
    const row = object(candidate, `incident timeline ${index}`)
    if (row.seq !== index + 1) throw new Error('incident timeline sequence is not contiguous')
    const at = Date.parse(nonEmptyString(row.at, `incident timeline ${index}.at`))
    if (!Number.isFinite(at) || at < priorAt) throw new Error('incident timeline timestamps are not monotonic')
    priorAt = at
    nonEmptyString(row.event, `incident timeline ${index}.event`)
  })
}

function validateLifecycle(rows: Record<string, any>[], identity: ReturnType<typeof validateIdentity>, certificateSha256: string): void {
  const matching = rows.map((row) => row?.data?.raw).filter((raw) => (
    raw?.data?.incidentId === identity.incidentId && raw?.data?.soulId === identity.soulId
  ))
  const committed = matching.filter((raw) => raw.event === 'supervisor.loss.incident_committed')
  const finalized = matching.filter((raw) => raw.event === 'supervisor.loss.finalized')
  if (committed.length !== 1 || finalized.length !== 1) throw new Error('loss lifecycle lacks one exact commit/finalize pair')
  const before = committed[0]
  const after = finalized[0]
  for (const row of [before, after]) {
    integer(row.sequence, 'loss lifecycle sequence')
    integer(row.monotonicNanos, 'loss lifecycle monotonic timestamp')
    integer(row.processId, 'loss lifecycle process id')
    if (row.data.certificateSha256 !== certificateSha256) throw new Error('loss lifecycle certificate hash does not match durable incident')
  }
  if (before.processId !== after.processId || before.sequence >= after.sequence
    || before.monotonicNanos >= after.monotonicNanos) {
    throw new Error('loss lifecycle incident commit does not monotonically precede cleanup finalization')
  }
  if (after.data.cleanupOutcome !== 'verified_empty') throw new Error('loss lifecycle finalization is not positively verified empty')
}
