import fs from 'node:fs'
import path from 'node:path'

import {
  array,
  artifactReference,
  equalString,
  exactKeys,
  integer,
  loadPhase5Evidence,
  nonEmptyString,
  object,
  stableJson,
  validateBrokerDestructiveTargets,
  validateCleanupContainsContainer,
  validateTestCounts,
  type LoadedPhase5Evidence,
  type RuntimeCandidateEvidence,
} from './runtime-phase5-evidence-common.js'

export const CHAOS_WEB_REPLACEMENT_CYCLES = 100
export const CHAOS_SUPERVISOR_REPLACEMENT_CYCLES = 20
export const CHAOS_MAX_CYCLE_GAP_MS = 120_000
export const CHAOS_MAX_LOG_BYTES = 8 * 1024 * 1024
export const PHASE5_CHAOS_ASSERTIONS_FILE = 'phase5-chaos-assertions.json'
export const PHASE5_CHAOS_PROVIDER_EVENTS_FILE = 'phase5-chaos-provider-events.json'

const ARTIFACT_FILES = {
  assertions: { fileName: PHASE5_CHAOS_ASSERTIONS_FILE, format: 'json' },
  providerEvents: { fileName: PHASE5_CHAOS_PROVIDER_EVENTS_FILE, format: 'json' },
  lifecycle: { fileName: 'lifecycle.jsonl', format: 'jsonl' },
  broker: { fileName: 'broker.jsonl', format: 'jsonl' },
  cleanup: { fileName: 'cleanup.json', format: 'json' },
  build: { fileName: 'build.json', format: 'json' },
  manifest: { fileName: 'manifest.json', format: 'json' },
  capabilityInventory: { fileName: 'phase5-capability-inventory.json', format: 'json' },
  serverLog: { fileName: 'phase5-chaos-server-log.jsonl', format: 'jsonl' },
  browserLog: { fileName: 'phase5-chaos-browser-log.jsonl', format: 'jsonl' },
} as const

export type Phase5ChaosSummary = {
  provider: string
  soulId: string
  incarnationId: string
  nativeSessionId: string
  webReplacementCycles: 100
  supervisorReplacementCycles: 20
  approvalDecisionCount: 1
  providerToolRequestCount: 2
  providerToolResultCount: 2
  replayCount: 0
  falseLossNoticeCount: 0
  unsafeBrokerAttempts: 0
  maxCycleGapMs: number
  serverLogBytes: number
  browserLogBytes: number
}

export type ValidatedPhase5ChaosReceipt = LoadedPhase5Evidence & { summary: Phase5ChaosSummary }

export function validatePhase5ChaosReceipt(input: {
  repoRoot: string
  candidateSha: string
  runtimeImage: string
  receipt: unknown
}): ValidatedPhase5ChaosReceipt {
  const loaded = loadPhase5Evidence({ ...input, kind: 'phase5_chaos', artifactFiles: ARTIFACT_FILES })
  const assertions = loaded.json.assertions
  exactKeys(assertions, [
    'schemaVersion', 'caseId', 'candidateSha', 'receiptRunId', 'test', 'identity',
    'webCycles', 'supervisorCycles', 'approval', 'longTool', 'falseLossQuery', 'followUp',
  ], 'chaos assertion artifact')
  if (assertions.schemaVersion !== 1 || assertions.caseId !== 'P5-G09') {
    throw new Error('chaos assertion artifact has the wrong schema or case')
  }
  equalString(assertions.candidateSha, input.candidateSha, 'chaos assertions candidate SHA')
  equalString(assertions.receiptRunId, loaded.receipt.receiptRunId, 'chaos assertions run id')
  validateTestCounts(assertions.test, 'chaos assertion test counts')
  const identity = validateIdentity(assertions.identity)
  capabilityFor(loaded.json.capabilityInventory, identity.provider)
  const web = validateWebCycles(assertions.webCycles, identity)
  const supervisor = validateSupervisorCycles(assertions.supervisorCycles, identity, web.lastEnded)
  validateApproval(assertions.approval)
  validateLongTool(assertions.longTool)
  validateFalseLossQuery(assertions.falseLossQuery, identity)
  validateFollowUp(assertions.followUp)
  validateProviderEvents(loaded.json.providerEvents, assertions, identity)
  validateBrokerDestructiveTargets(loaded.jsonl.broker, identity.containerId)
  validateCleanupContainsContainer(loaded.json.cleanup, identity.containerId)
  if (loaded.jsonl.lifecycle.length === 0) throw new Error('chaos lifecycle evidence is empty')
  if (loaded.bytes.serverLog.length === 0 || loaded.bytes.serverLog.length > CHAOS_MAX_LOG_BYTES
    || loaded.jsonl.serverLog.length === 0) throw new Error('chaos server log is missing or exceeds its bound')
  if (loaded.bytes.browserLog.length === 0 || loaded.bytes.browserLog.length > CHAOS_MAX_LOG_BYTES
    || loaded.jsonl.browserLog.length === 0) throw new Error('chaos browser log is missing or exceeds its bound')
  validateStructuredLog(loaded.jsonl.serverLog, 'server')
  validateStructuredLog(loaded.jsonl.browserLog, 'browser')

  const summary: Phase5ChaosSummary = {
    provider: identity.provider,
    soulId: identity.soulId,
    incarnationId: identity.incarnationId,
    nativeSessionId: identity.nativeSessionId,
    webReplacementCycles: 100,
    supervisorReplacementCycles: 20,
    approvalDecisionCount: 1,
    providerToolRequestCount: 2,
    providerToolResultCount: 2,
    replayCount: 0,
    falseLossNoticeCount: 0,
    unsafeBrokerAttempts: 0,
    maxCycleGapMs: Math.max(web.maxGap, supervisor.maxGap),
    serverLogBytes: loaded.bytes.serverLog.length,
    browserLogBytes: loaded.bytes.browserLog.length,
  }
  if (stableJson(loaded.receipt.summary) !== stableJson(summary)) {
    throw new Error('chaos receipt summary differs from evidence-derived summary')
  }
  return { ...loaded, summary }
}

export function buildPhase5ChaosReceipt(input: {
  repoRoot: string
  evidenceDir: string
  candidateSha: string
  runtimeImage: string
  receiptRunId: string
  candidateBefore: RuntimeCandidateEvidence
  candidateAfter: RuntimeCandidateEvidence
}): Record<string, any> {
  const evidenceRun = `.runtime-evidence/${input.candidateSha}/${input.receiptRunId}`
  const expected = path.join(fs.realpathSync(input.repoRoot), ...evidenceRun.split('/'))
  if (fs.realpathSync(input.evidenceDir) !== expected) throw new Error('chaos builder evidence directory is not the exact candidate run')
  const assertions = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, PHASE5_CHAOS_ASSERTIONS_FILE), 'utf8'))
  const identity = assertions.identity
  const web = validateWebCycles(assertions.webCycles, identity)
  const supervisor = validateSupervisorCycles(assertions.supervisorCycles, identity, web.lastEnded)
  const receipt = {
    schemaVersion: 2,
    kind: 'phase5_chaos',
    status: 'PASS',
    candidateSha: input.candidateSha,
    runtimeImage: input.runtimeImage,
    receiptRunId: input.receiptRunId,
    evidenceRun,
    candidateIntegrity: { before: input.candidateBefore, after: input.candidateAfter, failures: [] },
    artifacts: Object.fromEntries(Object.entries(ARTIFACT_FILES).map(([key, descriptor]) => [
      key, artifactReference(input.evidenceDir, evidenceRun, descriptor.fileName),
    ])),
    summary: {
      provider: identity.provider,
      soulId: identity.soulId,
      incarnationId: identity.incarnationId,
      nativeSessionId: identity.nativeSessionId,
      webReplacementCycles: 100,
      supervisorReplacementCycles: 20,
      approvalDecisionCount: 1,
      providerToolRequestCount: 2,
      providerToolResultCount: 2,
      replayCount: 0,
      falseLossNoticeCount: 0,
      unsafeBrokerAttempts: 0,
      maxCycleGapMs: Math.max(web.maxGap, supervisor.maxGap),
      serverLogBytes: fs.statSync(path.join(input.evidenceDir, 'phase5-chaos-server-log.jsonl')).size,
      browserLogBytes: fs.statSync(path.join(input.evidenceDir, 'phase5-chaos-browser-log.jsonl')).size,
    },
  }
  validatePhase5ChaosReceipt({ ...input, receipt })
  return receipt
}

export function phase5ChaosRetainedBundle(validated: ValidatedPhase5ChaosReceipt): {
  files: Record<string, Buffer>
  index: Record<string, unknown>
} {
  const names: Record<string, string> = {
    assertions: 'assertions.json', providerEvents: 'provider-events.json', lifecycle: 'lifecycle.jsonl',
    broker: 'broker.jsonl', cleanup: 'cleanup.json', build: 'build.json', manifest: 'manifest.json',
    capabilityInventory: 'capability-inventory.json', serverLog: 'server-log.jsonl', browserLog: 'browser-log.jsonl',
  }
  return {
    files: Object.fromEntries(Object.entries(names).map(([key, name]) => [name, validated.bytes[key]])),
    index: {
      schemaVersion: 1,
      candidateSha: validated.receipt.candidateSha,
      receiptRunId: validated.receipt.receiptRunId,
      evidenceRun: validated.receipt.evidenceRun,
      sourceReceiptSha256: validated.sourceReceiptSha256,
      files: Object.fromEntries(Object.entries(names).map(([key, name]) => [
        name,
        { originalPath: validated.receipt.artifacts[key].path, sha256: validated.receipt.artifacts[key].sha256 },
      ])),
    },
  }
}

type RuntimeIdentity = {
  soulId: string
  incarnationId: string
  containerId: string
  hostBootId: string
  nativeSessionId: string
  providerPid: number
  providerLaunchCount: number
  activeWriters: number
  unsafeBrokerAttempts: number
  limits: Record<string, string>
}

function validateIdentity(value: unknown): RuntimeIdentity & { provider: string } {
  const identity = object(value, 'chaos identity')
  exactKeys(identity, [
    'provider', 'providerVersion', 'model', 'paneId', 'terminalId', 'soulId',
    'incarnationId', 'containerId', 'hostBootId', 'nativeSessionId', 'providerPid',
    'providerLaunchCount', 'activeWriters', 'unsafeBrokerAttempts', 'limits',
  ], 'chaos identity')
  for (const key of [
    'provider', 'providerVersion', 'model', 'paneId', 'terminalId', 'soulId',
    'incarnationId', 'hostBootId', 'nativeSessionId',
  ]) nonEmptyString(identity[key], `chaos identity.${key}`)
  validateRuntime({
    soulId: identity.soulId,
    incarnationId: identity.incarnationId,
    containerId: identity.containerId,
    hostBootId: identity.hostBootId,
    nativeSessionId: identity.nativeSessionId,
    providerPid: identity.providerPid,
    providerLaunchCount: identity.providerLaunchCount,
    activeWriters: identity.activeWriters,
    unsafeBrokerAttempts: identity.unsafeBrokerAttempts,
    limits: identity.limits,
  }, identity as any)
  return identity as any
}

function validateRuntime(value: unknown, expected: RuntimeIdentity): void {
  const runtime = object(value, 'chaos cycle runtime')
  exactKeys(runtime, [
    'soulId', 'incarnationId', 'containerId', 'hostBootId', 'nativeSessionId',
    'providerPid', 'providerLaunchCount', 'activeWriters', 'unsafeBrokerAttempts', 'limits',
  ], 'chaos cycle runtime')
  for (const key of ['soulId', 'incarnationId', 'containerId', 'hostBootId', 'nativeSessionId', 'providerPid', 'providerLaunchCount']) {
    if (runtime[key] !== expected[key as keyof RuntimeIdentity]) throw new Error(`chaos runtime identity changed at ${key}`)
  }
  if (!/^[0-9a-f]{64}$/.test(runtime.containerId)) throw new Error('chaos runtime container identity is not exact')
  if (!Number.isSafeInteger(runtime.providerPid) || runtime.providerPid <= 1) throw new Error('chaos provider PID is invalid')
  if (runtime.providerLaunchCount !== 1) throw new Error('chaos provider process was relaunched')
  if (runtime.activeWriters !== 1) throw new Error('chaos runtime does not have exactly one writer')
  if (runtime.unsafeBrokerAttempts !== 0) throw new Error('chaos runtime observed an unsafe broker attempt')
  const limits = object(runtime.limits, 'chaos effective limits')
  exactKeys(limits, ['cpuMax', 'memoryMax', 'swapMax', 'pidsMax'], 'chaos effective limits')
  for (const key of ['cpuMax', 'memoryMax', 'pidsMax']) nonEmptyString(limits[key], `chaos limits.${key}`)
  if (limits.swapMax !== '0') throw new Error('chaos effective swap limit is not zero')
  if (stableJson(limits) !== stableJson(expected.limits)) throw new Error('chaos effective limits changed during replacement')
}

function validateWebCycles(value: unknown, identity: RuntimeIdentity): { lastEnded: number; maxGap: number } {
  const cycles = array(value, 'web replacement cycles')
  if (cycles.length !== CHAOS_WEB_REPLACEMENT_CYCLES) throw new Error('web replacement cycle count must be exactly 100')
  const pids = new Set<number>()
  const bootIds = new Set<string>()
  let priorAfter = -1
  let priorBootId = ''
  let priorEnded = -1
  let maxGap = 0
  for (const [index, candidate] of cycles.entries()) {
    const row = object(candidate, `web cycle ${index + 1}`)
    exactKeys(row, [
      'cycle', 'mode', 'attemptCount', 'startedMonotonicMs', 'endedMonotonicMs',
      'beforePid', 'afterPid', 'beforeBootId', 'afterBootId', 'runtime',
    ], `web cycle ${index + 1}`)
    const cycle = index + 1
    if (row.cycle !== cycle || row.mode !== (cycle % 2 === 1 ? 'abrupt' : 'graceful')) throw new Error('web cycle sequence or graceful/abrupt alternation is invalid')
    if (row.attemptCount !== 1) throw new Error('web cycle retry masking is forbidden')
    validateWindow(row, priorEnded, `web cycle ${cycle}`)
    if (index > 0 && (row.beforePid !== priorAfter || row.beforeBootId !== priorBootId)) {
      throw new Error('web replacement PID/boot identity chain is discontinuous')
    }
    if (!Number.isSafeInteger(row.beforePid) || !Number.isSafeInteger(row.afterPid) || row.beforePid <= 1 || row.afterPid <= 1 || row.beforePid === row.afterPid) {
      throw new Error('web replacement PID identity is invalid')
    }
    if (index === 0) pids.add(row.beforePid)
    nonEmptyString(row.beforeBootId, `web cycle ${cycle} before boot id`)
    nonEmptyString(row.afterBootId, `web cycle ${cycle} after boot id`)
    if (index === 0) bootIds.add(row.beforeBootId)
    if (pids.has(row.afterPid)) throw new Error('web replacement PID identity is not unique')
    if (bootIds.has(row.afterBootId)) throw new Error('web replacement boot identity is not unique')
    pids.add(row.afterPid)
    bootIds.add(row.afterBootId)
    maxGap = Math.max(maxGap, priorEnded < 0 ? 0 : row.startedMonotonicMs - priorEnded)
    priorEnded = row.endedMonotonicMs
    priorAfter = row.afterPid
    priorBootId = row.afterBootId
    validateRuntime(row.runtime, identity)
  }
  return { lastEnded: priorEnded, maxGap }
}

function validateSupervisorCycles(value: unknown, identity: RuntimeIdentity, priorPhaseEnded: number): { maxGap: number } {
  const cycles = array(value, 'supervisor replacement cycles')
  if (cycles.length !== CHAOS_SUPERVISOR_REPLACEMENT_CYCLES) throw new Error('supervisor replacement cycle count must be exactly 20')
  const containers = new Set<string>()
  const pids = new Set<number>()
  let priorContainer = ''
  let priorPid = -1
  let priorEpoch = -1
  let priorEnded = priorPhaseEnded
  let maxGap = 0
  for (const [index, candidate] of cycles.entries()) {
    const row = object(candidate, `supervisor cycle ${index + 1}`)
    exactKeys(row, [
      'cycle', 'mode', 'attemptCount', 'startedMonotonicMs', 'endedMonotonicMs',
      'beforeContainerId', 'afterContainerId', 'beforePid', 'afterPid',
      'beforeControlEpoch', 'afterControlEpoch', 'runtime',
    ], `supervisor cycle ${index + 1}`)
    const cycle = index + 1
    if (row.cycle !== cycle || row.mode !== (cycle % 2 === 1 ? 'abrupt' : 'graceful')) throw new Error('supervisor cycle sequence or graceful/abrupt alternation is invalid')
    if (row.attemptCount !== 1) throw new Error('supervisor cycle retry masking is forbidden')
    validateWindow(row, priorEnded, `supervisor cycle ${cycle}`)
    for (const key of ['beforeContainerId', 'afterContainerId']) {
      if (!/^[0-9a-f]{64}$/.test(row[key])) throw new Error('supervisor replacement container identity is not exact')
    }
    if (index > 0 && (row.beforeContainerId !== priorContainer || row.beforePid !== priorPid || row.beforeControlEpoch !== priorEpoch)) {
      throw new Error('supervisor replacement identity/epoch chain is discontinuous')
    }
    if (index === 0) { containers.add(row.beforeContainerId); pids.add(row.beforePid) }
    if (containers.has(row.afterContainerId) || pids.has(row.afterPid)) throw new Error('supervisor replacement identity is not unique')
    if (row.afterControlEpoch <= row.beforeControlEpoch) throw new Error('supervisor control epoch did not advance')
    containers.add(row.afterContainerId); pids.add(row.afterPid)
    maxGap = Math.max(maxGap, row.startedMonotonicMs - priorEnded)
    priorEnded = row.endedMonotonicMs
    priorContainer = row.afterContainerId
    priorPid = row.afterPid
    priorEpoch = row.afterControlEpoch
    validateRuntime(row.runtime, identity)
  }
  return { maxGap }
}

function validateWindow(row: Record<string, any>, priorEnded: number, label: string): void {
  const started = integer(row.startedMonotonicMs, `${label} start`)
  const ended = integer(row.endedMonotonicMs, `${label} end`)
  if (ended <= started) throw new Error(`${label} monotonic window is invalid`)
  if (priorEnded >= 0 && (started <= priorEnded || started - priorEnded > CHAOS_MAX_CYCLE_GAP_MS)) {
    throw new Error(`${label} monotonic gap is invalid or unbounded`)
  }
}

function validateApproval(value: unknown): void {
  const approval = object(value, 'chaos approval evidence')
  exactKeys(approval, ['toolRequestId', 'decisionsBeforeClick', 'decisionsAfterClick', 'markerCount'], 'chaos approval evidence')
  nonEmptyString(approval.toolRequestId, 'approval tool request id')
  if (approval.decisionsBeforeClick !== 0 || approval.decisionsAfterClick !== 1 || approval.markerCount !== 1) {
    throw new Error('approval evidence does not prove zero-before/one-after with one supplementary marker')
  }
}

function validateLongTool(value: unknown): void {
  const tool = object(value, 'chaos long-tool evidence')
  exactKeys(tool, ['toolRequestId', 'markerCount', 'sleepSeconds'], 'chaos long-tool evidence')
  nonEmptyString(tool.toolRequestId, 'long tool request id')
  if (tool.markerCount !== 1 || tool.sleepSeconds !== 180) throw new Error('long-tool evidence does not preserve the exact 180-second once-only case')
}

function validateFalseLossQuery(value: unknown, identity: RuntimeIdentity): void {
  const query = object(value, 'chaos false-loss query')
  exactKeys(query, ['profileId', 'soulId', 'evidenceRevision', 'matchingNoticeIds'], 'chaos false-loss query')
  if (query.profileId !== 'profile:phase5-chaos' || query.soulId !== identity.soulId) throw new Error('false-loss query is not bound to the exact profile and soul')
  if (!Number.isSafeInteger(query.evidenceRevision) || query.evidenceRevision <= 0) throw new Error('false-loss query lacks a durable evidence revision')
  if (!Array.isArray(query.matchingNoticeIds) || query.matchingNoticeIds.length !== 0) throw new Error('false-loss query found a matching notice')
}

function validateFollowUp(value: unknown): void {
  const followUp = object(value, 'chaos follow-up evidence')
  exactKeys(followUp, ['nativeMessageId', 'completed'], 'chaos follow-up evidence')
  nonEmptyString(followUp.nativeMessageId, 'follow-up native message id')
  if (followUp.completed !== true) throw new Error('chaos native follow-up did not complete')
}

function validateProviderEvents(value: unknown, assertions: Record<string, any>, identity: RuntimeIdentity): void {
  const events = object(value, 'chaos provider event evidence')
  exactKeys(events, ['schemaVersion', 'provider', 'nativeSessionId', 'approval', 'longTool', 'followUp'], 'chaos provider event evidence')
  if (events.schemaVersion !== 1 || events.provider !== (identity as any).provider || events.nativeSessionId !== identity.nativeSessionId) {
    throw new Error('chaos provider event evidence has the wrong native identity')
  }
  validateToolEvent(events.approval, assertions.approval.toolRequestId, true, 'approval provider tool')
  validateToolEvent(events.longTool, assertions.longTool.toolRequestId, false, 'long provider tool')
  const followUp = object(events.followUp, 'provider follow-up')
  exactKeys(followUp, ['messageIds', 'completedCount'], 'provider follow-up')
  if (stableJson(followUp.messageIds) !== stableJson([assertions.followUp.nativeMessageId]) || followUp.completedCount !== 1) {
    throw new Error('provider-native follow-up evidence is missing or duplicated')
  }
}

function validateToolEvent(value: unknown, requestId: string, approval: boolean, label: string): void {
  const event = object(value, label)
  exactKeys(event, approval
    ? ['requestIds', 'resultIds', 'providerDecisionCount', 'replayCount']
    : ['requestIds', 'resultIds', 'replayCount'], label)
  if (stableJson(event.requestIds) !== stableJson([requestId]) || stableJson(event.resultIds) !== stableJson([requestId])) {
    throw new Error(`${label} does not prove one matching provider request/result`)
  }
  if (event.replayCount !== 0 || (approval && event.providerDecisionCount !== 1)) {
    throw new Error(`${label} contains a replay or wrong provider decision count`)
  }
}

function validateStructuredLog(rows: Record<string, any>[], source: 'server' | 'browser'): void {
  let priorMonotonicMs = -1
  for (const [index, row] of rows.entries()) {
    exactKeys(row, [
      'source', 'sequence', 'monotonicMs', 'level', 'event',
      'contentSha256', 'contentBytes', 'redacted',
    ], `chaos ${source} log row ${index + 1}`)
    if (row.source !== source || row.sequence !== index + 1) {
      throw new Error(`chaos ${source} log sequence/source is not contiguous and exact`)
    }
    const monotonicMs = integer(row.monotonicMs, `chaos ${source} log monotonic time`)
    if (monotonicMs < priorMonotonicMs) throw new Error(`chaos ${source} log timeline is not monotonic`)
    priorMonotonicMs = monotonicMs
    nonEmptyString(row.level, `chaos ${source} log level`)
    nonEmptyString(row.event, `chaos ${source} log event`)
    if (!/^[0-9a-f]{64}$/.test(row.contentSha256)) throw new Error(`chaos ${source} log content digest is invalid`)
    integer(row.contentBytes, `chaos ${source} log content bytes`)
    if (row.redacted !== true) throw new Error(`chaos ${source} log was not redacted before persistence`)
  }
}

function capabilityFor(inventory: Record<string, any>, provider: string): void {
  const rows = inventory.providers.filter((row: any) => row?.provider === provider)
  if (rows.length !== 1 || rows[0].managedEnabled !== true || rows[0].durableRecoveryEnabled !== true) {
    throw new Error(`chaos provider ${provider} is not uniquely enabled by the candidate capability inventory`)
  }
}
