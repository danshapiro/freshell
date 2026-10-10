import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { captureNativeHistory } from '../../test/e2e-browser/helpers/provider-native-history/probe-cli.js'

import { deriveNativeRecoveryOriginals, readNativeOriginalReference, NATIVE_RECOVERY_ORIGINALS_FILE, type ObservedNativeConversation } from './qualification-observations.js'

import {
  QUALIFIABLE_FRESH_AGENT_MODES,
  type QualifiableFreshAgentMode,
} from './fresh-agent-qualification-selection.js'
import {
  FRESH_AGENT_INGRESS_INVENTORY,
  type FreshAgentIngressId,
} from './fresh-agent-ingress-inventory.js'

export const FRESH_AGENT_QUALIFICATION_ASSERTIONS_FILE = 'fresh-agent-qualification-assertions.json'
export const FRESH_AGENT_QUALIFICATION_BROKER_FILE = 'broker.jsonl'
export const FRESH_AGENT_QUALIFICATION_CLEANUP_FILE = 'cleanup.json'
export const FRESH_AGENT_QUALIFICATION_CANDIDATE_FILE = 'build.json'

const SHA256 = /^[a-f0-9]{64}$/
const CANDIDATE_SHA = /^[a-f0-9]{40}$/
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const MODE_CONTRACT = {
  freshclaude: {
    provider: 'claude',
    runtimeVariant: 'claude-agent-sdk',
    model: 'haiku',
    effort: 'low',
    pendingApproval: true,
  },
  kilroy: {
    provider: 'claude',
    runtimeVariant: 'kilroy-claude-agent-sdk',
    model: 'haiku',
    effort: 'low',
    pendingApproval: true,
  },
  freshcodex: {
    provider: 'codex',
    runtimeVariant: 'codex-app-server',
    model: 'gpt-5.6-luna',
    effort: 'low',
    pendingApproval: false,
  },
  freshopencode: {
    provider: 'opencode',
    runtimeVariant: 'opencode-per-soul-http',
    model: 'openai/gpt-5.6-luna',
    effort: 'provider-default',
    pendingApproval: false,
  },
} as const satisfies Record<QualifiableFreshAgentMode, {
  provider: string
  runtimeVariant: string
  model: string
  effort: string
  pendingApproval: boolean
}>

export type NativeTurnProof = {
  turnId: string
  assistantMessageId: string
  completionKind: 'provider_native_completed'
}

export type FreshAgentQualificationRow = {
  mode: QualifiableFreshAgentMode
  provider: string
  providerVersion: string
  model: string
  effort: string
  runtimeVariant: string
  actualProviderProcess: true
  fixtureTransport: false
  ingresses: FreshAgentIngressId[]
  soulId: string
  nativeSessionId: string
  providerStoreId: string
  completedNativeTurns: NativeTurnProof[]
  noToolRecall: boolean
  crashes: {
    web: string[]
    host: string[]
  }
  pendingApproval:
    | { supported: false }
    | {
        supported: true
        survivedWebRestart: boolean
        survivedHostRecovery: boolean
        resolvedExactlyOnce: boolean
        decisionIdHash: string
      }
  writerProof: {
    activeWriterCount: number
    conflictingWriterCount: number
    dispatchCountForPrompt: number
    completionCountForPrompt: number
  }
  isolation: {
    providerVolumeNameHash: string
    enclosureIdHash: string
    independentProviderStore: boolean
    independentEnclosure: boolean
  }
  limits: {
    cpuMax: string
    memoryMax: string
    swapMax: string
    pidsMax: string
  }
  oldEnclosure: {
    verifiedEmptyBeforeResume: boolean
    writerClaimReleasedBeforeResume: boolean
  }
  [key: string]: unknown
}

export type FreshQualificationArtifactReference = {
  path: string
  sha256: string
}

export type FreshAgentQualificationReceiptV1 = {
  schemaVersion: 1
  lane: 'fresh_agent_live'
  status: 'PASS'
  candidateSha: string
  receiptRunId: string
  evidenceRun: string
  runtimeImage: string
  selectedModes: QualifiableFreshAgentMode[]
  rows: FreshAgentQualificationRow[]
  artifacts: {
    candidate: FreshQualificationArtifactReference
    assertions: FreshQualificationArtifactReference
    broker: FreshQualificationArtifactReference
    cleanup: FreshQualificationArtifactReference
    nativeOriginals: FreshQualificationArtifactReference
  }
}

export type BuildFreshAgentQualificationReceiptInput = {
  repoRoot: string
  evidenceDir: string
  candidateSha: string
  receiptRunId: string
  runtimeImage: string
  selectedModes: QualifiableFreshAgentMode[]
  rows: FreshAgentQualificationRow[]
}

export type ValidateFreshAgentQualificationReceiptInput = {
  repoRoot: string
  candidateSha: string
  expectedRuntimeImage: string
  receipt: unknown
}

export function buildFreshAgentQualificationReceipt(
  input: BuildFreshAgentQualificationReceiptInput,
): FreshAgentQualificationReceiptV1 {
  validateCandidate(input.candidateSha, input.runtimeImage, input.receiptRunId)
  const repoRoot = fs.realpathSync(input.repoRoot)
  const evidenceRun = expectedEvidenceRun(input.candidateSha, input.receiptRunId)
  const expectedDir = path.join(repoRoot, ...evidenceRun.split('/'))
  if (fs.realpathSync(input.evidenceDir) !== expectedDir) {
    throw new Error(`fresh-agent evidence directory must be the candidate-bound run ${evidenceRun}`)
  }
  validateRunArtifacts(expectedDir, input.candidateSha, input.receiptRunId, input.runtimeImage, input.selectedModes)
  validateRows(repoRoot, input.selectedModes, input.rows)
  rejectSensitiveFields(input.rows)
  assertBrokerSafe(readRegularFile(path.join(expectedDir, FRESH_AGENT_QUALIFICATION_BROKER_FILE), 'broker artifact'))
  assertCleanupSafe(readRegularFile(path.join(expectedDir, FRESH_AGENT_QUALIFICATION_CLEANUP_FILE), 'cleanup artifact'))

  const observed = deriveNativeRecoveryOriginals({ evidenceDir: expectedDir, candidateSha: input.candidateSha, runId: input.receiptRunId, runtimeImage: input.runtimeImage, selected: input.selectedModes })
  validateDerivedNativeRows(input.rows, observed)
  validateNativeProfiles(repoRoot, expectedDir, input.rows, input.candidateSha, input.receiptRunId, input.runtimeImage, observed)

  const assertionPath = path.join(expectedDir, FRESH_AGENT_QUALIFICATION_ASSERTIONS_FILE)
  fs.writeFileSync(assertionPath, JSON.stringify({
    schemaVersion: 1,
    lane: 'fresh_agent_live',
    candidateSha: input.candidateSha,
    receiptRunId: input.receiptRunId,
    runtimeImage: input.runtimeImage,
    selectedModes: input.selectedModes,
    rows: input.rows,
  }, null, 2), { mode: 0o600 })

  const artifact = (fileName: string): FreshQualificationArtifactReference => ({
    path: `${evidenceRun}/${fileName}`,
    sha256: sha256File(path.join(expectedDir, fileName)),
  })
  const receipt: FreshAgentQualificationReceiptV1 = {
    schemaVersion: 1,
    lane: 'fresh_agent_live',
    status: 'PASS',
    candidateSha: input.candidateSha,
    receiptRunId: input.receiptRunId,
    evidenceRun,
    runtimeImage: input.runtimeImage,
    selectedModes: [...input.selectedModes],
    rows: input.rows,
    artifacts: {
      candidate: artifact(FRESH_AGENT_QUALIFICATION_CANDIDATE_FILE),
      assertions: artifact(FRESH_AGENT_QUALIFICATION_ASSERTIONS_FILE),
      broker: artifact(FRESH_AGENT_QUALIFICATION_BROKER_FILE),
      cleanup: artifact(FRESH_AGENT_QUALIFICATION_CLEANUP_FILE),
      nativeOriginals: artifact(NATIVE_RECOVERY_ORIGINALS_FILE),
    },
  }
  validateFreshAgentQualificationReceipt({
    repoRoot,
    candidateSha: input.candidateSha,
    expectedRuntimeImage: input.runtimeImage,
    receipt,
  })
  return receipt
}

export function validateFreshAgentQualificationReceipt(
  input: ValidateFreshAgentQualificationReceiptInput,
): { receipt: FreshAgentQualificationReceiptV1, rows: FreshAgentQualificationRow[] } {
  const receipt = object(input.receipt, 'fresh-agent qualification receipt')
  if (receipt.schemaVersion !== 1) throw new Error('fresh-agent qualification receipt must use schema v1; legacy evidence is rejected')
  if (receipt.lane !== 'fresh_agent_live') throw new Error('fresh-agent qualification receipt has the wrong lane')
  if (receipt.status !== 'PASS') throw new Error('fresh-agent qualification receipt is not PASS')
  validateCandidate(input.candidateSha, input.expectedRuntimeImage, receipt.receiptRunId)
  stringEqual(receipt.candidateSha, input.candidateSha, 'receipt candidate SHA')
  stringEqual(receipt.runtimeImage, input.expectedRuntimeImage, 'receipt runtime image')
  const evidenceRun = expectedEvidenceRun(input.candidateSha, receipt.receiptRunId)
  stringEqual(receipt.evidenceRun, evidenceRun, 'receipt evidence run')

  const repoRoot = fs.realpathSync(input.repoRoot)
  const evidenceDir = path.join(repoRoot, ...evidenceRun.split('/'))
  if (!fs.existsSync(evidenceDir)) throw new Error(`fresh-agent evidence run is missing: ${evidenceRun}`)
  if (fs.realpathSync(evidenceDir) !== evidenceDir) throw new Error('fresh-agent evidence run must not traverse a symlink')
  validateRows(repoRoot, receipt.selectedModes, receipt.rows)
  rejectSensitiveFields(receipt.rows)

  const artifacts = object(receipt.artifacts, 'fresh-agent receipt artifacts')
  const candidateBytes = validateArtifact(evidenceDir, evidenceRun, FRESH_AGENT_QUALIFICATION_CANDIDATE_FILE, artifacts.candidate)
  const assertionBytes = validateArtifact(evidenceDir, evidenceRun, FRESH_AGENT_QUALIFICATION_ASSERTIONS_FILE, artifacts.assertions)
  const brokerBytes = validateArtifact(evidenceDir, evidenceRun, FRESH_AGENT_QUALIFICATION_BROKER_FILE, artifacts.broker)
  const cleanupBytes = validateArtifact(evidenceDir, evidenceRun, FRESH_AGENT_QUALIFICATION_CLEANUP_FILE, artifacts.cleanup)
  // Candidate bytes are hashed independently above; parse again so a valid
  // digest over a stale build can never satisfy this validator.
  const candidate = parseJsonObject(candidateBytes, 'candidate build artifact')
  stringEqual(candidate.candidateSha, input.candidateSha, 'candidate build SHA')
  stringEqual(candidate.runtimeImage, input.expectedRuntimeImage, 'candidate runtime image')
  validateRunArtifacts(evidenceDir, input.candidateSha, receipt.receiptRunId, input.expectedRuntimeImage, receipt.selectedModes)

  const assertion = parseJsonObject(assertionBytes, 'fresh-agent assertion artifact')
  if (assertion.schemaVersion !== 1 || assertion.lane !== 'fresh_agent_live') {
    throw new Error('fresh-agent assertion artifact has an unsupported schema or lane')
  }
  stringEqual(assertion.candidateSha, input.candidateSha, 'assertion candidate SHA')
  stringEqual(assertion.receiptRunId, receipt.receiptRunId, 'assertion run id')
  stringEqual(assertion.runtimeImage, input.expectedRuntimeImage, 'assertion runtime image')
  if (stableJson(assertion.selectedModes) !== stableJson(receipt.selectedModes)
    || stableJson(assertion.rows) !== stableJson(receipt.rows)) {
    throw new Error('fresh-agent receipt summary differs from its hashed assertion artifact')
  }
  validateRows(repoRoot, assertion.selectedModes, assertion.rows)
  rejectSensitiveFields(assertion.rows)
  assertBrokerSafe(brokerBytes)
  assertCleanupSafe(cleanupBytes)
  validateArtifact(evidenceDir, evidenceRun, NATIVE_RECOVERY_ORIGINALS_FILE, artifacts.nativeOriginals)
  const nativeReference = object(artifacts.nativeOriginals, 'native originals reference')
  const observed = deriveNativeRecoveryOriginals({ evidenceDir, candidateSha: input.candidateSha, runId: receipt.receiptRunId, runtimeImage: input.expectedRuntimeImage, selected: receipt.selectedModes, originalReference: { path: NATIVE_RECOVERY_ORIGINALS_FILE, sha256: nativeReference.sha256 } })
  validateDerivedNativeRows(assertion.rows, observed)
  validateNativeProfiles(repoRoot, evidenceDir, assertion.rows, input.candidateSha, receipt.receiptRunId, input.expectedRuntimeImage, observed)
  return {
    receipt: receipt as FreshAgentQualificationReceiptV1,
    rows: assertion.rows,
  }
}

function validateStoppedNativeRead(stopped: Record<string, any>, row: FreshAgentQualificationRow,
  lastView: Record<string, any>, lastCompletedAt: number): void {
  const stopResult = object(stopped.stopResult, 'stopped Stop result'), writer = object(stopped.writer, 'stopped writer observation')
  stringEqual(stopResult.outcome, 'verified_empty', 'stopped Stop outcome')
  for (const view of [object(stopResult.view, 'stopped Stop view'), object(stopped.stoppedView, 'stopped inventory view')]) {
    for (const [field, expected] of Object.entries({ soulId: row.soulId, nativeSessionId: row.nativeSessionId,
      incarnationId: lastView.incarnationId, containerId: lastView.containerId, hostBootId: lastView.hostBootId,
      provider: row.mode === 'kilroy' ? 'kilroy' : row.provider, launchState: 'stopped', desiredState: 'stopped', cleanupState: 'verified_empty' })) {
      stringEqual(view[field], expected, `stopped view ${field}`)
    }
    if (view.executionGeneration !== lastView.executionGeneration) throw new Error('stopped execution generation differs')
  }
  for (const [field, expected] of Object.entries({ provider: row.mode === 'kilroy' ? 'kilroy' : row.provider,
    soulId: row.soulId, providerStoreId: row.providerStoreId, nativeSessionId: row.nativeSessionId, incarnationId: lastView.incarnationId })) {
    stringEqual(writer[field], expected, `stopped writer ${field}`)
  }
  if (writer.activeClaimCount !== 0 || writer.globalConflictingClaimCount !== 0) throw new Error('stopped writer is active or conflicting')
  let previousObservation = lastCompletedAt
  for (const field of ['stopCompletedAt', 'stoppedObservedAt', 'writerObservedAt', 'readStartedAt', 'readCompletedAt']) {
    const at = stopped[field]
    if (!Number.isSafeInteger(at) || at <= 0 || at < previousObservation) throw new Error('stopped native read order differs')
    previousObservation = at
  }
}

/** Profile configuration and optional native effort are separate observations. */
function validateNativeProfiles(repoRoot: string, evidenceDir: string, rows: FreshAgentQualificationRow[], candidateSha: string, runId: string, runtimeImage: string, observed: ObservedNativeConversation[]): void {
  const manifest = parseJsonObject(readRegularFile(path.join(evidenceDir, NATIVE_RECOVERY_ORIGINALS_FILE), 'native profiles manifest'), 'native profiles manifest')
  const source = (reference: unknown, label: string) => {
    if (!reference) throw new Error(`native profile ${label} original is missing`)
    const value = parseJsonObject(readNativeOriginalReference(evidenceDir, reference).bytes, `native profile ${label}`)
    for (const [field, expected] of Object.entries({ candidateSha, runId, runtimeImage })) stringEqual(value.execution?.[field], expected, `profile source ${field}`)
    return value
  }
  const sdkPin = rows.some(row => row.provider === 'claude')
    ? parseJsonObject(readRegularFile(path.join(repoRoot, 'crates/freshell-claude-sidecar/package.json'), 'sidecar package'), 'sidecar package').dependencies?.['@anthropic-ai/claude-agent-sdk'] : null
  for (const [index, row] of rows.entries()) {
    for (const stage of manifest.conversations[index].stages) {
      const profile = source(stage.profile, 'capture'), process = source(profile.process, 'process'), accepted = source(profile.accepted, 'accepted launch')
      const namespace = source(stage.namespace, 'namespace'), launch = source(stage.launch, 'launch')
      const view = launch.response?.data?.view ?? launch.response?.result?.Ok?.data?.view
      stringEqual(profile.mode, row.mode, 'profile mode')
      stringEqual(process.provider, row.provider, 'profile provider')
      stringEqual(process.version, row.providerVersion, 'profile native version')
      stringEqual(accepted.source, 'registry-current-incarnation', 'accepted profile source')
      for (const field of ['soulId', 'providerStoreId', 'nativeSessionId'] as const) stringEqual(accepted[field], row[field], `accepted ${field}`)
      for (const field of ['incarnationId', 'containerId', 'launchNonce', 'executionGeneration'] as const) {
        const expected = field === 'launchNonce' ? view.nativeIdentityObservation.launchNonce : view[field]
        if (accepted[field] !== expected) throw new Error(`accepted current profile ${field} differs`)
      }
      const native = object(process.native, 'native profile process'), spec = object(accepted.spec, 'accepted fresh profile')
      if (native.pid !== namespace.nativePid || native.uid !== 65534 || !/^\d+$/.test(native.startTicks ?? '') || !Number.isSafeInteger(native.parentPid)
        || native.parentPid < 1 || !path.isAbsolute(native.executable ?? '')) throw new Error('profile actual native process identity differs')
      for (const field of ['executableSha256', 'profileSha256'] as const) stringEqual(native[field], namespace[field], `profile ${field}`)
      stringEqual(native.cwd, namespace.nativeCwd, 'native profile cwd')
      for (const field of ['incarnationId', 'launchNonce', 'executionGeneration', 'evidenceRevision'] as const) {
        const expected = field === 'executionGeneration' ? view.executionGeneration : view.nativeIdentityObservation[field]
        if (native.launch?.[field] !== expected) throw new Error(`native profile launch ${field} differs`)
      }
      for (const [field, expected] of Object.entries({ sessionType: row.mode, provider: row.mode === 'kilroy' ? 'kilroy' : row.provider,
        runtimeVariant: row.runtimeVariant, providerStoreId: row.providerStoreId, nativeSessionId: row.nativeSessionId, cwd: namespace.nativeCwd, model: row.model })) {
        stringEqual(spec[field], expected, `accepted profile ${field}`)
      }
      if ((spec.effort ?? 'provider-default') !== row.effort) throw new Error('accepted profile configured effort differs')
      if (row.provider === 'claude') {
        stringEqual(native.configuredModel, row.model, 'native argv configured model')
        stringEqual(native.configuredEffort, row.effort, 'native argv configured effort')
        const sdk = object(process.sdk, 'selected SDK profile')
        stringEqual(sdk.version, sdkPin, 'selected SDK version')
        stringEqual(sdk.declaredNativeVersion, row.providerVersion, 'SDK native version')
        stringEqual(sdk.selection, 'sidecar-selected-module-resolution', 'SDK resolution provenance')
        const metadata = parseJsonObject(readNativeOriginalReference(evidenceDir, sdk.packageSource).bytes, 'SDK package original')
        stringEqual(metadata.name, '@anthropic-ai/claude-agent-sdk', 'SDK package name')
        stringEqual(metadata.version, sdkPin, 'SDK package version')
        stringEqual(metadata.claudeCodeVersion, row.providerVersion, 'SDK package native version')
        for (const [reference, expected] of [[sdk.moduleSource, sdk.moduleSha256], [sdk.entrySource, sdk.entrySha256]]) {
          stringEqual(createHash('sha256').update(readNativeOriginalReference(evidenceDir, reference).bytes).digest('hex'), expected, 'SDK selected source digest')
        }
      }
    }
    const conversation = manifest.conversations[index], last = conversation.stages.at(-1)
    const stopped = source(conversation.stopped, 'stopped raw read'), stoppedStore = source(stopped.store, 'stopped store')
    const lastStore = source(last.store, 'last current store'), lastLaunch = source(last.launch, 'last launch')
    const lastView = lastLaunch.response?.data?.view ?? lastLaunch.response?.result?.Ok?.data?.view
    validateStoppedNativeRead(stopped, row, lastView, observed[index]!.stages.at(-1)!.completedAt)
    const finalSource = readNativeOriginalReference(evidenceDir, stopped.nativeFile)
    const captured = Buffer.from(stoppedStore.snapshot.querySnapshotBase64 ?? stoppedStore.snapshot.bytesBase64, 'base64')
    if (!finalSource.bytes.equals(captured) || createHash('sha256').update(captured).digest('hex') !== (stoppedStore.snapshot.querySnapshotSha256 ?? stoppedStore.snapshot.sha256)
      || stoppedStore.snapshot.completeEof !== true || JSON.stringify(stoppedStore.snapshot.identity.slice(0, 2)) !== JSON.stringify(lastStore.snapshot.identity.slice(0, 2))) throw new Error('stopped raw source capture differs')
    stringEqual(stoppedStore.providerVolumeName, lastStore.providerVolumeName, 'stopped provider volume')
    stringEqual(stoppedStore.containerId, lastView.containerId, 'stopped container')
    stringEqual(stoppedStore.snapshot.path, lastStore.snapshot.path, 'stopped native source path')
    const rawHistory = (reference: unknown) => {
      const { filename } = readNativeOriginalReference(evidenceDir, reference)
      return captureNativeHistory(row.provider, row.provider === 'opencode' ? filename : path.dirname(filename), row.nativeSessionId).turns
    }
    if (stableJson(rawHistory(stopped.nativeFile)) !== stableJson(rawHistory(last.nativeFile))) throw new Error('stopped native completed prefix differs')
  }
  for (const [index, row] of rows.entries()) {
    for (const stage of observed[index]!.stages) {
      const expectedProvider = row.provider === 'claude' ? 'anthropic' : 'openai'
      const expectedModel = row.provider === 'claude' ? 'claude-haiku-4-5-20251001' : 'gpt-5.6-luna'
      stringEqual(stage.profile.provider, expectedProvider, 'native completed profile provider')
      stringEqual(stage.profile.observedModel, expectedModel, 'native completed profile model')
      if (stage.profile.effort !== null && stage.profile.effort !== row.effort) throw new Error('native observed effort differs from intended profile')
    }
  }
}

function validateDerivedNativeRows(rows: FreshAgentQualificationRow[], observed: ObservedNativeConversation[]): void {
  for (const [index, row] of rows.entries()) {
    const conversation = observed[index]!
    for (const field of ['mode', 'soulId', 'providerStoreId', 'nativeSessionId'] as const) stringEqual(conversation[field], row[field], `native ${field}`)
    const derived = conversation.stages.map(stage => {
      if (stage.nativeEvidence.kind !== 'identified_message') throw new Error('fresh native completion requires actual native message IDs')
      return { turnId: stage.nativeEvidence.turnId, assistantMessageId: stage.nativeEvidence.messageId, completionKind: 'provider_native_completed' }
    })
    if (stableJson(derived) !== stableJson(row.completedNativeTurns)) throw new Error('native completed turns differ from declared receipt turns')
  }
}

function validateRows(
  repoRoot: string,
  selectedModesValue: unknown,
  rowsValue: unknown,
): asserts rowsValue is FreshAgentQualificationRow[] {
  if (!Array.isArray(selectedModesValue) || selectedModesValue.length === 0) {
    throw new Error('fresh-agent selectedModes must contain at least one exact mode')
  }
  if (!Array.isArray(rowsValue) || rowsValue.length === 0) {
    throw new Error('fresh-agent qualification must contain at least one tested row')
  }
  const allowed = new Set<string>(QUALIFIABLE_FRESH_AGENT_MODES)
  const selectedModes = selectedModesValue.map((mode) => nonEmptyString(mode, 'selected mode'))
  for (const mode of selectedModes) {
    if (!allowed.has(mode)) throw new Error(`fresh-agent selected mode ${mode} is unsupported`)
  }
  assertNoDuplicates(selectedModes, 'selected mode')
  const modes = rowsValue.map((candidate) => nonEmptyString(object(candidate, 'fresh-agent row').mode, 'row mode'))
  assertNoDuplicates(modes, 'fresh-agent row')
  if (stableJson(selectedModes) !== stableJson(modes)) {
    throw new Error('fresh-agent rows must exactly match selectedModes in declared order')
  }

  const versions = object(
    parseJsonObject(readRegularFile(path.join(repoRoot, 'docker/runtime/provider-versions.json'), 'provider version manifest'), 'provider version manifest').providers,
    'pinned provider versions',
  )
  for (const candidate of rowsValue) {
    const row = object(candidate, 'fresh-agent row')
    const mode = row.mode as QualifiableFreshAgentMode
    const contract = MODE_CONTRACT[mode]
    if (!contract) throw new Error(`${mode} has no fresh-agent qualification contract`)
    for (const [field, expected] of Object.entries({
      provider: contract.provider,
      runtimeVariant: contract.runtimeVariant,
      model: contract.model,
      effort: contract.effort,
    })) stringEqual(row[field], expected, `${mode}.${field}`)
    if (row.actualProviderProcess !== true || row.fixtureTransport !== false) {
      throw new Error(`${mode} must prove an actual provider process and no fixture transport`)
    }
    const requiredIngresses = FRESH_AGENT_INGRESS_INVENTORY.map(({ ingress }) => ingress)
    if (stableJson(row.ingresses) !== stableJson(requiredIngresses)) {
      throw new Error(`${mode}.ingresses must exactly cover the executable doorway inventory`)
    }
    const pinned = object(versions[contract.provider], `${contract.provider} pinned provider version`)
    stringEqual(row.providerVersion, nonEmptyString(contract.provider === 'claude' ? pinned.sdkNativeVersion : pinned.version, `${contract.provider} pinned version`), `${mode}.providerVersion`)
    for (const field of ['soulId', 'nativeSessionId', 'providerStoreId'] as const) {
      nonEmptyString(row[field], `${mode}.${field}`)
    }
    validateNativeTurns(mode, row.completedNativeTurns)
    if (row.noToolRecall !== true) throw new Error(`${mode}.noToolRecall must be true`)
    validateCrashes(mode, row.crashes)
    validatePendingApproval(mode, contract.pendingApproval, row.pendingApproval)
    const writer = object(row.writerProof, `${mode}.writerProof`)
    if (writer.activeWriterCount !== 1) throw new Error(`${mode}.writerProof.activeWriterCount must be 1`)
    if (writer.conflictingWriterCount !== 0) throw new Error(`${mode}.writerProof.conflictingWriterCount must be 0`)
    if (writer.dispatchCountForPrompt !== 1) throw new Error(`${mode}.writerProof.dispatchCountForPrompt must be 1`)
    if (writer.completionCountForPrompt !== 1) throw new Error(`${mode}.writerProof.completionCountForPrompt must be 1`)
    const isolation = object(row.isolation, `${mode}.isolation`)
    for (const field of ['providerVolumeNameHash', 'enclosureIdHash'] as const) requireSha256(isolation[field], `${mode}.isolation.${field}`)
    if (isolation.independentProviderStore !== true) throw new Error(`${mode}.isolation.independentProviderStore must be true`)
    if (isolation.independentEnclosure !== true) throw new Error(`${mode}.isolation.independentEnclosure must be true`)
    validateLimits(mode, row.limits)
    const old = object(row.oldEnclosure, `${mode}.oldEnclosure`)
    if (old.verifiedEmptyBeforeResume !== true) throw new Error(`${mode}.oldEnclosure.verifiedEmptyBeforeResume must be true`)
    if (old.writerClaimReleasedBeforeResume !== true) throw new Error(`${mode}.oldEnclosure.writerClaimReleasedBeforeResume must be true`)
  }
  const stores = rowsValue.map((row) => row.providerStoreId)
  const enclosures = rowsValue.map((row) => object(row.isolation, 'row isolation').enclosureIdHash as string)
  assertNoDuplicates(stores, 'provider store')
  assertNoDuplicates(enclosures, 'enclosure')
}

function validateNativeTurns(mode: string, value: unknown): void {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`${mode}.completedNativeTurns must contain initial and no-tool recall completions`)
  }
  const ids: string[] = []
  for (const candidate of value) {
    const turn = object(candidate, `${mode}.completedNativeTurns row`)
    ids.push(nonEmptyString(turn.turnId, `${mode}.completedNativeTurns.turnId`))
    nonEmptyString(turn.assistantMessageId, `${mode}.completedNativeTurns.assistantMessageId`)
    if (turn.completionKind !== 'provider_native_completed') {
      throw new Error(`${mode}.completedNativeTurns must use provider_native_completed proofs`)
    }
  }
  assertNoDuplicates(ids, `${mode} completed native turn`)
}

function validateCrashes(mode: string, value: unknown): void {
  const crashes = object(value, `${mode}.crashes`)
  const web = stringArray(crashes.web, `${mode} web crashes`)
  const host = stringArray(crashes.host, `${mode} host crashes`)
  if (!web.includes('abrupt_restart')) throw new Error(`${mode} web crashes must include abrupt_restart`)
  for (const required of ['session_host_exit', 'provider_process_exit']) {
    if (!host.includes(required)) throw new Error(`${mode} host crashes must include ${required}`)
  }
}

function validatePendingApproval(mode: string, supported: boolean, value: unknown): void {
  const pending = object(value, `${mode}.pendingApproval`)
  if (pending.supported !== supported) {
    throw new Error(`${mode}.pendingApproval.supported must be ${supported}`)
  }
  if (!supported) {
    if (Object.keys(pending).some((key) => key !== 'supported')) {
      throw new Error(`${mode}.pendingApproval must not invent unsupported decision proof`)
    }
    return
  }
  if (pending.survivedWebRestart !== true || pending.survivedHostRecovery !== true
    || pending.resolvedExactlyOnce !== true) {
    throw new Error(`${mode}.pendingApproval must survive web/host recovery and resolve exactly once`)
  }
  requireSha256(pending.decisionIdHash, `${mode}.pendingApproval.decisionIdHash`)
}

function validateLimits(mode: string, value: unknown): void {
  const limits = object(value, `${mode}.limits`)
  for (const field of ['cpuMax', 'memoryMax', 'swapMax', 'pidsMax'] as const) {
    nonEmptyString(limits[field], `${mode}.limits.${field}`)
  }
  if (limits.cpuMax === 'max') throw new Error(`${mode}.limits.cpuMax must be bounded`)
  if (limits.memoryMax === 'max') throw new Error(`${mode}.limits.memoryMax must be bounded`)
  if (limits.pidsMax === 'max') throw new Error(`${mode}.limits.pidsMax must be bounded`)
  if (limits.swapMax !== '0') throw new Error(`${mode}.limits.swapMax must prove swap is disabled`)
}

function validateRunArtifacts(
  evidenceDir: string,
  candidateSha: string,
  runId: string,
  runtimeImage: string,
  selectedModes: unknown,
): void {
  const manifest = parseJsonObject(readRegularFile(path.join(evidenceDir, 'manifest.json'), 'run manifest'), 'run manifest')
  const execution = object(manifest.execution, 'run manifest execution')
  stringEqual(execution.candidateSha, candidateSha, 'run manifest candidate SHA')
  stringEqual(execution.runId, runId, 'run manifest run id')
  const build = parseJsonObject(readRegularFile(path.join(evidenceDir, 'build.json'), 'candidate build artifact'), 'candidate build artifact')
  stringEqual(build.candidateSha, candidateSha, 'candidate build SHA')
  stringEqual(build.runtimeImage, runtimeImage, 'candidate runtime image')
  const qualification = object(build.freshAgentQualificationBuild, 'fresh-agent qualification build')
  if (qualification.kind !== 'production') {
    throw new Error('deterministic fresh-agent fixtures cannot satisfy a live qualification receipt')
  }
  if (stableJson(qualification.serverFeatures) !== stableJson(['managed-runtime-v1'])
    || stableJson(qualification.sessionHostFeatures) !== stableJson([])
    || stableJson(qualification.fixtureModes) !== stableJson([])) {
    throw new Error('live fresh-agent qualification must use production server and session-host features')
  }
  if (stableJson(qualification.selectedModes) !== stableJson(selectedModes)) {
    throw new Error('fresh-agent qualification build selected modes differ from the receipt')
  }
  const binaries = object(build.binaries, 'candidate binaries')
  for (const key of ['server', 'supervisor', 'sessionHost']) {
    requireSha256(object(binaries[key], `${key} binary`).sha256, `${key} binary SHA-256`)
  }
}

function validateArtifact(
  evidenceDir: string,
  evidenceRun: string,
  fileName: string,
  candidate: unknown,
): Buffer {
  const artifact = object(candidate, `${fileName} artifact reference`)
  stringEqual(artifact.path, `${evidenceRun}/${fileName}`, `${fileName} artifact path`)
  requireSha256(artifact.sha256, `${fileName} artifact SHA-256`)
  const bytes = readRegularFile(path.join(evidenceDir, fileName), `${fileName} artifact`)
  const actual = sha256(bytes)
  if (actual !== artifact.sha256) throw new Error(`${fileName} artifact SHA-256 digest mismatch`)
  return bytes
}

function assertBrokerSafe(bytes: Buffer): void {
  const lines = bytes.toString('utf8').split(/\r?\n/).filter((line) => line.trim())
  if (lines.length === 0) throw new Error('broker artifact contains no broker events')
  for (const [index, line] of lines.entries()) {
    const event = parseJsonObject(Buffer.from(line), `broker artifact line ${index + 1}`)
    if (event.unsafeAttempt === true) throw new Error('broker artifact contains an unsafe attempt')
  }
}

function assertCleanupSafe(bytes: Buffer): void {
  const cleanup = parseJsonObject(bytes, 'cleanup artifact')
  if (cleanup.ok !== true || !Array.isArray(cleanup.errors) || cleanup.errors.length !== 0
    || !Array.isArray(cleanup.unsafeBrokerAttempts) || cleanup.unsafeBrokerAttempts.length !== 0) {
    throw new Error('cleanup artifact does not prove exact safe cleanup')
  }
}

const FORBIDDEN_KEY = /^(?:responseText|prompt|credentialValue|rawProviderEvents|workspaceData)$/i

function rejectSensitiveFields(value: unknown, location = 'rows'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSensitiveFields(entry, `${location}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error(`forbidden sensitive receipt field at ${location}.${key}`)
    rejectSensitiveFields(child, `${location}.${key}`)
  }
}

function validateCandidate(candidateSha: unknown, runtimeImage: unknown, runId: unknown): void {
  if (typeof candidateSha !== 'string' || !CANDIDATE_SHA.test(candidateSha)) throw new Error('candidate SHA must be an exact 40-character lowercase git SHA')
  if (typeof runtimeImage !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(runtimeImage)) throw new Error('runtime image must be an exact sha256 digest')
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) throw new Error('receipt run ID is invalid')
}

function expectedEvidenceRun(candidateSha: string, runId: string): string {
  validateCandidate(candidateSha, `sha256:${'0'.repeat(64)}`, runId)
  return `.runtime-evidence/${candidateSha}/${runId}`
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, any>
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.trim() !== value) {
    throw new Error(`${label} must be a bounded non-empty string`)
  }
  return value
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new Error(`${label} must be an array of non-empty strings`)
  }
  assertNoDuplicates(value, label)
  return value
}

function assertNoDuplicates(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate evidence`)
}

function stringEqual(actual: unknown, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label} does not match the exact expected value`)
}

function requireSha256(value: unknown, label: string): void {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} must be a SHA-256 digest`)
}

function readRegularFile(file: string, label: string): Buffer {
  let stat: fs.Stats
  try { stat = fs.lstatSync(file) } catch { throw new Error(`${label} is missing`) }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 16 * 1024 * 1024) {
    throw new Error(`${label} must be a bounded direct regular file`)
  }
  return fs.readFileSync(file)
}

function parseJsonObject(bytes: Buffer, label: string): Record<string, any> {
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error(`${label} is not valid JSON`) }
  return object(value, label)
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256File(file: string): string {
  return sha256(readRegularFile(file, path.basename(file)))
}

function stableJson(value: unknown): string {
  return JSON.stringify(value)
}
