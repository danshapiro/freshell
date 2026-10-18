import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readCodexNativeObservation } from '../../test/e2e-browser/helpers/provider-native-history/codex.js'
import { readOpenCodeNativeObservation } from '../../test/e2e-browser/helpers/provider-native-history/opencode.js'
import { readClaudeNativeHistory } from '../../test/e2e-browser/helpers/provider-native-history/claude.js'
import { readAmplifierNativeHistory } from '../../test/e2e-browser/helpers/provider-native-history/amplifier.js'
import { readBoundedJsonl, readBoundedJsonlWithPositions } from '../../test/e2e-browser/helpers/provider-native-history/safe-io.js'
import { hasSuccessfulNativeAnswer, type NativeAssistantTurn, type NativeHistory } from './provider-native-history.js'

export const NATIVE_RECOVERY_ORIGINALS_FILE = 'native-recovery-originals.json'
export type NativeOriginalReference = { path: string; sha256: string }
export type NativeRecoveryStage = 'initial' | 'after_session_host_crash' | 'after_provider_process_crash'
export type NativeRecoveryValidationDiagnostic = Readonly<{
  code: 'recovery_nonce_not_recalled'
  stage: Exclude<NativeRecoveryStage, 'initial'>
}>

export class NativeRecoveryValidationError extends Error {
  readonly diagnostic: NativeRecoveryValidationDiagnostic

  constructor(stage: NativeRecoveryValidationDiagnostic['stage']) {
    super('native recovery completion does not recall the seed nonce')
    this.name = 'NativeRecoveryValidationError'
    this.diagnostic = Object.freeze({ code: 'recovery_nonce_not_recalled', stage })
  }
}

/** Only fixed validation facts may cross the body-free owner lifecycle boundary. */
export function nativeRecoveryValidationDiagnostic(error: unknown): NativeRecoveryValidationDiagnostic | undefined {
  if (!(error instanceof NativeRecoveryValidationError)) return undefined
  const diagnostic = error.diagnostic
  if (diagnostic?.code !== 'recovery_nonce_not_recalled'
    || (diagnostic.stage !== 'after_session_host_crash' && diagnostic.stage !== 'after_provider_process_crash')) return undefined
  return { code: 'recovery_nonce_not_recalled', stage: diagnostic.stage }
}

export type NativeRecoveryStageEvidence = {
  stage: NativeRecoveryStage
  nativeSessionId: string
  providerStoreId: string
  incarnationId: string
  executionGeneration: number
  requestId: string
  nativeEvidence: NativeAssistantTurn['nativeEvidence']
  completedAt: number
  responseSha256: string
  noTools: true
  recalledNonce: boolean
  profile: { provider: string; model: string; observedModel: string | null; modelProvenance: string; effort: string | null; effortProvenance: string }
}
export type ObservedNativeConversation = { mode: string; soulId: string; providerStoreId: string; nativeSessionId: string; stages: NativeRecoveryStageEvidence[] }
type JsonObject = Record<string, any>
type NativeInput = { id: string; text: string; appendPosition?: { recordIndex: number; byteStart: number; byteEnd: number } }
const MODE_PROVIDER: Readonly<Record<string, string>> = { claude: 'claude', freshclaude: 'claude', kilroy: 'claude', codex: 'codex', freshcodex: 'codex', opencode: 'opencode', freshopencode: 'opencode', amplifier: 'amplifier' }
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

/** Free TLS access and paid authenticated HTTP access are separate observations. */
export function nativeNamespaceAccessMatches(namespace: JsonObject, mode: string): boolean {
  if (namespace.tlsVerifyMode !== 2 || namespace.tlsCheckHostname !== true) return false
  if (mode !== 'freshopencode') return namespace.httpsStatus === 200 && !namespace.freeModelAccess
  const access = namespace.freeModelAccess
  if (namespace.httpsStatus !== null || access?.source !== 'native-config-providers' || access.providerId !== 'opencode'
    || access.modelId !== 'big-pickle' || access.ca !== 'system-default' || !/^[a-f0-9]{64}$/.test(access.peerCertificateSha256 ?? '')) return false
  try {
    const endpoint = new URL(access.endpoint)
    return endpoint.protocol === 'https:' && Boolean(endpoint.hostname) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
  } catch { return false }
}
const object = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a native evidence object`)
  return value as JsonObject
}
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 65_536) throw new Error(`${label} must be bounded nonempty native text`)
  return value
}
const timestamp = (value: unknown, label: string): number => {
  const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isSafeInteger(at) || at <= 0) throw new Error(`${label} lacks a native timestamp`)
  return at
}
const equal = (actual: unknown, expected: unknown, label: string) => {
  if (actual !== expected) throw new Error(`${label} differs from the native original`)
}
const unique = (values: unknown[], label: string) => {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate native evidence`)
}

/** All references remain in the finite private run directory, including parent components. */
export function readNativeOriginalReference(evidenceDir: string, value: unknown): { filename: string; bytes: Buffer } {
  const reference = object(value, 'native original reference')
  const relative = text(reference.path, 'native original path')
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new Error('native original path must be a bounded run-relative file')
  if (!/^[a-f0-9]{64}$/.test(reference.sha256 ?? '')) throw new Error('native original digest is invalid')
  const root = fs.realpathSync(evidenceDir), filename = path.join(root, relative)
  let stat: fs.Stats
  try { stat = fs.lstatSync(filename) } catch { throw new Error('native original is missing') }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 8 * 1024 * 1024 || fs.realpathSync(filename) !== filename) throw new Error('native original must be a bounded canonical regular file')
  const bytes = fs.readFileSync(filename)
  equal(sha256(bytes), reference.sha256, 'native original digest')
  return { filename, bytes }
}

function jsonReference(evidenceDir: string, reference: unknown): JsonObject {
  const { bytes } = readNativeOriginalReference(evidenceDir, reference)
  return object(JSON.parse(bytes.toString('utf8')), 'native original')
}

function verifyCapturedNativeCopy(evidenceDir: string, reference: unknown, bytesBase64: string, digest: string, label: string): Buffer {
  const copied = readNativeOriginalReference(evidenceDir, reference).bytes
  const captured = Buffer.from(bytesBase64, 'base64')
  if (!copied.equals(captured)) throw new Error(`${label} differs from the captured native original`)
  equal(sha256(captured), digest, `${label} capture digest`)
  return copied
}

export function nativeMaterial(evidenceDir: string, stage: JsonObject, provider: string, root: string): { history: NativeHistory; inputs: NativeInput[] } {
  const { filename } = readNativeOriginalReference(evidenceDir, stage.nativeFile)
  if (provider === 'codex') {
    const basename = path.basename(filename), [meta] = readBoundedJsonl(filename, 'Codex referenced native rollout')
    if (!basename.endsWith('.jsonl') || !basename.includes(root) || meta?.type !== 'session_meta' || (meta.payload?.id ?? meta.payload?.session_id) !== root) throw new Error('Codex native reference does not name the exact rollout')
    const observation = readCodexNativeObservation(path.dirname(filename), root)
    return { history: observation.history, inputs: observation.inputs.map(input => ({ id: input.turnId, text: input.text })) }
  }
  if (provider === 'opencode') {
    const observation = readOpenCodeNativeObservation(filename, root)
    return { history: observation.history, inputs: observation.inputs.map(input => ({ id: input.messageId, text: input.text })) }
  }
  if (provider === 'claude') {
    equal(path.basename(filename), `${root}.jsonl`, 'Claude exact native reference')
    const rows = readBoundedJsonl(filename, 'Claude native inputs')
    return { history: readClaudeNativeHistory(path.dirname(filename), root), inputs: rows.filter(row => row.type === 'user' && row.message?.role === 'user' && (typeof row.message.content === 'string' || row.message.content?.some((part: JsonObject) => part.type === 'text'))).map(row => ({ id: text(row.uuid, 'Claude native user UUID'), text: typeof row.message.content === 'string' ? row.message.content : row.message.content.filter((part: JsonObject) => part.type === 'text').map((part: JsonObject) => text(part.text, 'Claude native input')).join('') })) }
  }
  if (provider === 'amplifier') {
    const events = readNativeOriginalReference(evidenceDir, stage.nativeEvents)
    equal(path.basename(filename), 'transcript.jsonl', 'Amplifier exact transcript reference')
    equal(path.basename(events.filename), 'events.jsonl', 'Amplifier exact events reference')
    equal(path.basename(path.dirname(filename)), root, 'Amplifier exact native store directory')
    equal(path.dirname(events.filename), path.dirname(filename), 'Amplifier events/transcript store')
    const records = readBoundedJsonlWithPositions(filename, 'Amplifier native inputs')
    const inputs = records.flatMap(record => {
      const row = record.value
      if (row.role !== 'user') return []
      return [{
        id: String(record.recordIndex),
        text: typeof row.content === 'string' ? row.content : row.content.filter((part: JsonObject) => part.type === 'text').map((part: JsonObject) => text(part.text, 'Amplifier native input')).join(''),
        appendPosition: { recordIndex: record.recordIndex, byteStart: record.byteStart, byteEnd: record.byteEnd },
      }]
    })
    return { history: readAmplifierNativeHistory(path.dirname(path.dirname(path.dirname(filename))), root), inputs }
  }
  throw new Error('unsupported native original provider')
}

function observedNativeProfile(turn: NativeAssistantTurn): NativeRecoveryStageEvidence['profile'] {
  if (turn.resolvedReasoningEffort === 'unknown' && turn.reasoningEffortProvenance !== 'unsupported-native-telemetry') throw new Error('native effort lacks truthful telemetry provenance')
  const configuredProfile = turn.modelProvenance.startsWith('amplifier-session:config')
  return {
    provider: turn.resolvedProvider,
    model: turn.resolvedModel,
    observedModel: configuredProfile ? null : turn.resolvedModel,
    modelProvenance: turn.modelProvenance,
    effort: turn.resolvedReasoningEffort === 'unknown' || configuredProfile ? null : turn.resolvedReasoningEffort,
    effortProvenance: configuredProfile ? 'unsupported-native-telemetry' : turn.reasoningEffortProvenance,
  }
}

/** Derives only native recovery turns. It does not certify approval, writer order or ingress. */
export function deriveNativeRecoveryOriginals(input: {
  evidenceDir: string; candidateSha: string; runId: string; runtimeImage: string; selected: readonly string[]
  originalReference?: NativeOriginalReference
  requiredStages?: readonly NativeRecoveryStage[]
}): ObservedNativeConversation[] {
  const file = path.join(input.evidenceDir, NATIVE_RECOVERY_ORIGINALS_FILE)
  const reference = input.originalReference ?? { path: NATIVE_RECOVERY_ORIGINALS_FILE, sha256: (() => { try { return sha256(fs.readFileSync(file)) } catch { throw new Error('native originals artifact is missing') } })() }
  const originals = jsonReference(input.evidenceDir, reference)
  equal(originals.schemaVersion, 1, 'native original schema')
  equal(originals.candidateSha, input.candidateSha, 'native candidate')
  equal(originals.runId, input.runId, 'native run')
  equal(originals.runtimeImage, input.runtimeImage, 'native image')
  const source = (reference: unknown): JsonObject => {
    const captured = jsonReference(input.evidenceDir, reference)
    equal(captured.execution?.candidateSha, input.candidateSha, 'native source candidate')
    equal(captured.execution?.runId, input.runId, 'native source run')
    equal(captured.execution?.runtimeImage, input.runtimeImage, 'native source image')
    return captured
  }
  equal(JSON.stringify(originals.selected), JSON.stringify(input.selected), 'native selected modes')
  if (!Array.isArray(originals.conversations) || originals.conversations.length !== input.selected.length) throw new Error('native originals must exactly cover selected conversations')
  const requiredStages = input.requiredStages ?? ['initial', 'after_session_host_crash', 'after_provider_process_crash']
  return originals.conversations.map((value: unknown, conversationIndex: number) => {
    const conversation = object(value, 'native conversation')
    equal(conversation.mode, input.selected[conversationIndex], 'native mode')
    const soulId = text(conversation.soulId, 'native soul'), providerStoreId = text(conversation.providerStoreId, 'native store'), root = text(conversation.nativeSessionId, 'native root')
    const provider = text(conversation.provider, 'native provider'), nonce = text(conversation.nonce, 'native seed nonce')
    equal(provider, MODE_PROVIDER[conversation.mode], 'native mode provider')
    if (!Array.isArray(conversation.stages) || JSON.stringify(conversation.stages.map((stage: JsonObject) => stage.stage)) !== JSON.stringify(requiredStages)) throw new Error('native recovery stages are missing, duplicated or reordered')
    const stages: NativeRecoveryStageEvidence[] = []
    const requestIds: string[] = [], incarnationIds: string[] = [], launchNonces: string[] = []
    let previousView: JsonObject | undefined, previousCompletion = 0, previousNamespace: JsonObject | undefined, previousStore: JsonObject | undefined
    let previousTranscript: Buffer | undefined
    let priorTurns = new Map<string, NativeAssistantTurn>(), priorInputs = new Map<string, string>()
    const key = (turn: NativeAssistantTurn) => JSON.stringify(turn.nativeEvidence)
    for (const stageValue of conversation.stages) {
      const stage = object(stageValue, 'native stage'), launch = source(stage.launch)
      const view = object(launch.response?.data?.view ?? launch.response?.result?.Ok?.data?.view, 'native current launch view')
      const observation = object(view.nativeIdentityObservation, 'native current identity observation')
      equal(view.soulId, soulId, 'native launch soul'); equal(launch.request?.params?.providerStoreId ?? view.providerStoreId, providerStoreId, 'native launch store')
      equal(view.nativeSessionId, root, 'native launch root'); equal(observation.nativeSessionId, root, 'native observed root')
      equal(view.launchState, 'running', 'native launch state'); equal(view.recoveryState, 'live', 'native recovery state')
      const incarnationId = text(view.incarnationId, 'native incarnation'), launchNonce = text(observation.launchNonce, 'native launch nonce')
      equal(observation.incarnationId, incarnationId, 'native observed incarnation')
      if (!Number.isSafeInteger(observation.evidenceRevision) || observation.evidenceRevision < 0 || !/^[a-f0-9]{64}$/.test(observation.evidenceDigest ?? '')) throw new Error('native observation revision/digest is missing')
      const launchAt = timestamp(launch.capturedAt, 'native observation capture')
      if (!Number.isSafeInteger(view.executionGeneration) || view.executionGeneration < 1) throw new Error('native execution generation is missing')
      const namespace = source(stage.namespace)
      const probe = object(namespace.ownedProbe, 'native current owned namespace probe')
      equal(probe.containerId, view.containerId, 'native namespace probe container')
      if (!Number.isSafeInteger(namespace.nativePid) || namespace.nativePid < 1) throw new Error('native namespace probe lacks an actual provider PID')
      equal(probe.nativePid, namespace.nativePid, 'native namespace probe process')
      const namespaceAt = timestamp(probe.capturedAt, 'native namespace probe capture')
      if (namespace.uid !== 65534 || namespace.gid !== 0 || namespace.caps !== '0000000000000000' || namespace.readOnlyRoot !== true || !nativeNamespaceAccessMatches(namespace, conversation.mode)) throw new Error('native namespace UID/profile/TLS boundary differs')
      // The Codex process probe has no thread-load RPC producer; its null
      // telemetry cannot replace the launch observation and exact rollout.
      if (provider !== 'codex' || namespace.nativeRoot !== null) equal(namespace.nativeRoot, root, 'native namespace root')
      text(namespace.nativeCwd, 'native namespace working directory')
      for (const field of ['executableSha256', 'profileSha256']) if (!/^[a-f0-9]{64}$/.test(namespace[field] ?? '')) throw new Error(`native namespace ${field} is missing`)
      if (namespace.nativeLaunch) {
        equal(namespace.nativeLaunch.incarnationId, incarnationId, 'native child incarnation')
        equal(namespace.nativeLaunch.launchNonce, launchNonce, 'native child launch nonce')
        equal(namespace.nativeLaunch.evidenceRevision, observation.evidenceRevision, 'native child revision')
        equal(namespace.nativeLaunch.executionGeneration, view.executionGeneration, 'native child generation')
      }
      const store = source(stage.store)
      equal(store.containerId, view.containerId, 'native snapshot container')
      text(store.providerVolumeName, 'native original volume')
      const snapshot = object(store.snapshot, 'native store snapshot')
      if (!snapshot.completeEof || !Array.isArray(snapshot.identity) || snapshot.identity.length < 2) throw new Error('native original store is truncated or lacks file identity')
      const transcript = verifyCapturedNativeCopy(input.evidenceDir, stage.nativeFile, snapshot.querySnapshotBase64 ?? snapshot.bytesBase64, snapshot.querySnapshotSha256 ?? snapshot.sha256, 'native transcript copy')
      if (provider === 'amplifier') {
        const events = object(store.eventsSnapshot, 'Amplifier captured native events')
        verifyCapturedNativeCopy(input.evidenceDir, stage.nativeEvents, events.bytesBase64, events.sha256, 'Amplifier event copy')
      }
      if (previousStore && previousNamespace) {
        equal(store.providerVolumeName, previousStore.providerVolumeName, 'native original volume')
        equal(snapshot.path, previousStore.snapshot.path, 'native original store path')
        if (provider === 'amplifier') {
          // The pinned SessionStore atomically replaces its complete transcript
          // on save. Durable continuity binds the same device and all prior
          // bytes, while the capture producer requires a stable descriptor.
          equal(snapshot.identity[0], previousStore.snapshot.identity[0], 'native original store device')
          if (!previousTranscript || !transcript.subarray(0, previousTranscript.length).equals(previousTranscript)) throw new Error('Amplifier native transcript prefix changed or disappeared')
        } else {
          equal(JSON.stringify(snapshot.identity.slice(0, 2)), JSON.stringify(previousStore.snapshot.identity.slice(0, 2)), 'native original store identity')
        }
        for (const field of ['nativeCwd', 'executableSha256', 'profileSha256']) equal(namespace[field], previousNamespace[field], `native replacement ${field}`)
      }
      if (previousView) {
        const crash = source(stage.crash)
        equal(crash.kind, stage.stage === 'after_session_host_crash' ? 'session_host_exit' : 'provider_process_exit', 'native recovery crash kind')
        equal(crash.containerId, previousView.containerId, 'native old container'); equal(crash.incarnationId, previousView.incarnationId, 'native old incarnation')
        const requestedAt = timestamp(crash.requestedAt, 'native crash request'), exitedAt = timestamp(crash.exitedAt, 'native owned exit')
        if (namespaceAt < exitedAt || timestamp(previousNamespace!.ownedProbe.capturedAt, 'previous native namespace capture') > requestedAt) throw new Error('native namespace probe precedes replacement or follows owned death')
        // Execution grants increment an incarnation-local counter. Recovery
        // requires a new incarnation, whose committed generation may restart at 1.
        if (!(previousCompletion <= requestedAt && requestedAt <= exitedAt && exitedAt <= launchAt) || view.containerId === previousView.containerId || incarnationId === previousView.incarnationId || observation.evidenceRevision <= previousView.nativeIdentityObservation.evidenceRevision) throw new Error('native crash/exit/replacement order is invalid')
      } else if (stage.crash !== undefined) throw new Error('initial native stage must precede recovery')
      const request = source(stage.request)
      const gestures: JsonObject[] = Array.isArray(request.requests) ? request.requests : [request]
      if (gestures.length < 1 || gestures.length > 2) throw new Error('native prompt has ambiguous input gestures')
      const requestId = text(gestures.at(-1)?.requestId, 'native request ID')
      const sentAt = timestamp(gestures.at(-1)?.sentAt, 'native request dispatch')
      for (const gesture of gestures) {
        if (timestamp(gesture.sentAt, 'native gesture') < launchAt || gesture.reply?.result?.Err) throw new Error('native input precedes replacement observation or was refused')
        equal(gesture.request?.params?.soulId, soulId, 'native request soul')
        requestIds.push(text(gesture.requestId, 'native gesture request ID'))
      }
      let prompt: string
      if (gestures.length === 2) {
        const paste = text(gestures[0]?.request?.params?.data, 'native terminal paste')
        if (gestures.some(gesture => gesture.request?.method !== 'terminal_input') || !paste.startsWith('\x1b[200~') || !paste.endsWith('\x1b[201~') || gestures[1]?.request?.params?.data !== '\r' || gestures[0]!.sentAt > sentAt) throw new Error('native terminal paste/submit order is invalid')
        prompt = paste.slice(6, -6)
      } else if (gestures[0]!.request?.method === 'fresh_agent_send') prompt = text(gestures[0]!.request.params.text, 'native submitted prompt')
      else {
        const data = text(gestures[0]!.request?.params?.data, 'native submitted terminal input')
        if (gestures[0]!.request.method !== 'terminal_input' || !data.endsWith('\r')) throw new Error('native terminal input lacks a submit gesture')
        prompt = data.slice(0, -1)
      }
      if (stage.stage === 'initial' && !prompt.includes(nonce)) throw new Error('native initial prompt lacks the seed nonce')
      if (stage.stage !== 'initial' && prompt.includes(nonce)) throw new Error('native recovery input reintroduces the seed nonce')
      const material = nativeMaterial(input.evidenceDir, stage, provider, root)
      equal(material.history.nativeSessionId, root, 'native completed root'); equal(material.history.provider, provider, 'native completed provider')
      if (stage.boundaryFile) {
        const boundary = nativeMaterial(input.evidenceDir, { ...stage, nativeFile: stage.boundaryFile, nativeEvents: stage.boundaryEvents }, provider, root)
        if (previousView && (JSON.stringify(boundary.history.turns) !== JSON.stringify([...priorTurns.values()]) || JSON.stringify(boundary.inputs.map(nativeInput => [nativeInput.id, nativeInput.text])) !== JSON.stringify([...priorInputs]))) throw new Error('native replacement input boundary differs from the retained seed')
        priorTurns = new Map(boundary.history.turns.map(turn => [key(turn), turn])); priorInputs = new Map(boundary.inputs.map(nativeInput => [nativeInput.id, nativeInput.text]))
      }
      unique(material.inputs.map(nativeInput => nativeInput.id), 'native user input'); unique(material.history.turns.map(key), 'native completion')
      if (provider !== 'amplifier') {
        unique(material.history.turns.map(turn => turn.turnId), 'native completed turn ID')
        unique(material.history.turns.map(turn => turn.messageId), 'native assistant message ID')
      }
      for (const [id, prior] of priorTurns) {
        const retained = material.history.turns.find(turn => key(turn) === id)
        if (!retained || JSON.stringify(retained) !== JSON.stringify(prior)) throw new Error('native completed prefix changed or disappeared')
      }
      for (const [id, prior] of priorInputs) if (!material.inputs.some(nativeInput => nativeInput.id === id && nativeInput.text === prior)) throw new Error('native input prefix changed or disappeared')
      const newInputs = material.inputs.filter(nativeInput => !priorInputs.has(nativeInput.id)), turns = material.history.turns.filter(turn => !priorTurns.has(key(turn)))
      if (newInputs.length !== 1 || turns.length !== 1) throw new Error('native request must have exactly one new input and completion')
      equal(newInputs[0]!.text, prompt, 'native request/input text')
      const turn = turns[0]!, completedAt = timestamp(turn.completedAt, 'native completion')
      if (completedAt < sentAt || turn.toolCalls.length) throw new Error('native completion precedes dispatch or includes tools')
      if (!hasSuccessfulNativeAnswer(turn, provider)) throw new Error('native completion failed or contains no assistant answer')
      if (provider === 'codex') equal(turn.turnId, newInputs[0]!.id, 'native input/completed turn')
      if (provider === 'opencode' || provider === 'claude') equal(turn.parentMessageId, newInputs[0]!.id, 'native assistant/user parent')
      if (provider === 'amplifier') {
        const inputPosition = newInputs[0]!.appendPosition, evidence = turn.nativeEvidence
        if (!inputPosition || evidence.kind !== 'append_only_record' || inputPosition.recordIndex + 1 !== evidence.recordIndex || inputPosition.byteEnd >= evidence.byteStart) throw new Error('Amplifier completed assistant lacks an unambiguous preceding native input append interval')
      }
      if (gestures.at(-1)?.reply?.data?.submittedTurnId !== undefined) equal(gestures.at(-1)!.reply.data.submittedTurnId, turn.turnId, 'native submitted/completed turn')
      const recalledNonce = stage.stage !== 'initial' && turn.text.includes(nonce)
      if (stage.stage !== 'initial' && !recalledNonce) throw new NativeRecoveryValidationError(stage.stage)
      const profile = observedNativeProfile(turn)
      if (stage.observedReasoningEffort !== undefined && stage.observedReasoningEffort !== profile.effort) throw new Error('declared observed effort is absent from native telemetry')
      stages.push({
        stage: stage.stage, nativeSessionId: root, providerStoreId, incarnationId,
        executionGeneration: view.executionGeneration, requestId, nativeEvidence: turn.nativeEvidence,
        completedAt, responseSha256: sha256(turn.text), noTools: true, recalledNonce, profile,
      })
      incarnationIds.push(incarnationId); launchNonces.push(launchNonce)
      previousView = view; previousCompletion = completedAt; previousNamespace = namespace; previousStore = store
      previousTranscript = transcript
      priorTurns = new Map(material.history.turns.map(nativeTurn => [key(nativeTurn), nativeTurn])); priorInputs = new Map(material.inputs.map(nativeInput => [nativeInput.id, nativeInput.text]))
    }
    unique(requestIds, 'native request'); unique(incarnationIds, 'native incarnation'); unique(launchNonces, 'native launch')
    return { mode: conversation.mode, soulId, providerStoreId, nativeSessionId: root, stages }
  })
}
