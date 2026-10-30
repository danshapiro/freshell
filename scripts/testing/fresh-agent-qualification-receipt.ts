import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { captureNativeHistory } from '../../test/e2e-browser/helpers/provider-native-history/probe-cli.js'
import { hasSuccessfulNativeAnswer } from './provider-native-history.js'
import { nativeCheckpointTranscriptRetained, observeNativeSoloBashOutcome } from './runtime-native-feasibility.js'

import { deriveNativeRecoveryOriginals, nativeMaterial, readNativeOriginalReference, NATIVE_RECOVERY_ORIGINALS_FILE, type ObservedNativeConversation } from './qualification-observations.js'

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
    model: 'opencode/big-pickle',
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

export type FreshBrowserIngressObservation = {
  ingress: FreshAgentIngressId
  request: Record<string, any>
  reply?: Record<string, any>
}

/** Outgoing browser frames can retain the create ID until materialization.
 * Both addresses must belong to this exact launch-bound native observation.
 * Raw host dispatches use nativeSessionId. Proxy send acknowledgments keep
 * freshAgentSessionId except OpenCode, whose route can materialize to nativeSessionId.
 */
export function matchesFreshBrowserFrame(view: any, frame: Record<string, any> | undefined): boolean {
  const contract = MODE_CONTRACT[view?.freshAgentSessionType as QualifiableFreshAgentMode]
  return !!contract && view.provider === (view.freshAgentSessionType === 'kilroy' ? 'kilroy' : contract.provider)
    && view.launchState === 'running' && view.recoveryState === 'live'
    && typeof view.freshAgentSessionId === 'string' && !!view.freshAgentSessionId
    && typeof view.nativeSessionId === 'string' && !!view.nativeSessionId
    && view.nativeIdentityObservation?.nativeSessionId === view.nativeSessionId
    && view.nativeIdentityObservation.incarnationId === view.incarnationId
    && !!frame && (frame.sessionId === view.nativeSessionId || frame.sessionId === view.freshAgentSessionId)
    && (frame.provider === undefined || frame.provider === contract.provider)
    && (frame.sessionType === undefined || frame.sessionType === view.freshAgentSessionType)
}

export function matchesFreshBrowserSendAccepted(view: any, frame: Record<string, any> | undefined): boolean {
  return frame?.type === 'freshAgent.send.accepted' && matchesFreshBrowserFrame(view, frame)
    && (frame.sessionId === view.freshAgentSessionId
      || (view.freshAgentSessionType === 'freshopencode' && frame.sessionId === view.nativeSessionId))
}

export function sameFreshBrowserActivation(view: Record<string, any>, expected: Record<string, any> | undefined): boolean {
  return !!expected && ['soulId', 'nativeSessionId', 'freshAgentSessionId', 'freshAgentSessionType', 'provider',
    'incarnationId', 'containerId', 'hostBootId', 'executionGeneration'].every(field => view[field] === expected[field])
    && view.nativeIdentityObservation?.launchNonce === expected.nativeIdentityObservation?.launchNonce
}

export function validateFreshBrowserAlias(route: Record<string, any>, main: { soulId: string; nativeSessionId: string; providerStoreId: string; provider: string }): void {
  const { view, writer, request, reply } = route
  if (request?.body?.sessionRef?.provider !== main.provider || request.body.sessionRef.sessionId !== main.nativeSessionId
    || view?.soulId !== main.soulId || view.nativeSessionId !== main.nativeSessionId
    || reply?.sessionId !== main.nativeSessionId || writer?.providerStoreId !== main.providerStoreId
    || writer.soulId !== main.soulId || writer.nativeSessionId !== main.nativeSessionId || writer.incarnationId !== view.incarnationId
    || writer.activeClaimCount !== 1 || writer.globalConflictingClaimCount !== 0) throw new Error('executed alias did not resume the registered main soul/store/root')
}

export function validateFreshApprovalCheckpoint(card: any, native: any, files: any[], view: any, command: string): void {
  const payload = card.payload, checkpoint = payload.nativeCheckpoint, binding = payload.nativeBinding
  const bytes = Buffer.from(native.transcript.bytesBase64, 'base64')
  if (!bytes.length || bytes.length > 32 * 1024 * 1024 || bytes.at(-1) !== 10 || !native.transcript.completeEof
    || createHash('sha256').update(bytes).digest('hex') !== native.transcript.sha256) throw new Error('native approval transcript is incomplete')
  const lines = bytes.toString('utf8').split('\n').filter(Boolean), rows = lines.map(line => JSON.parse(line))
  const index = rows.findIndex(row => row.uuid === checkpoint.checkpointUuid), deferred = rows[index]
  const assistant = rows.slice(0, index).find(row => row.uuid === checkpoint.assistantUuid)
  const batch = rows.filter(row => row.type === 'assistant' && row.message?.id === assistant?.message?.id)
  const tools = batch.flatMap(row => row.message.content.filter((part: any) => part.type === 'tool_use'))
  const digest = (input: any) => createHash('sha256').update(stableJson(input)).digest('hex')
  if (native.nativeRoot !== view.nativeSessionId || checkpoint.nativeSessionId !== view.nativeSessionId
    || checkpoint.nativeVersion !== '2.1.237' || checkpoint.toolName !== 'Bash' || checkpoint.toolUseID !== payload.toolUseID
    || payload.tool?.name !== 'Bash' || payload.tool.input?.command !== command || digest(payload.tool.input) !== checkpoint.inputDigest
    || !assistant?.message.id || !assistant.uuid || batch.some(row => row.sessionId !== view.nativeSessionId || row.version !== checkpoint.nativeVersion)
    || tools.length !== 1 || tools[0].id !== payload.toolUseID || tools[0].name !== 'Bash' || digest(tools[0].input) !== checkpoint.inputDigest
    || deferred?.type !== 'attachment' || deferred.sessionId !== view.nativeSessionId || deferred.version !== checkpoint.nativeVersion
    || deferred.attachment?.type !== 'hook_deferred_tool' || deferred.attachment.hookEvent !== 'PreToolUse'
    || deferred.attachment.toolUseID !== payload.toolUseID || deferred.attachment.toolName !== 'Bash'
    || digest(deferred.attachment.toolInput) !== checkpoint.inputDigest
    || lines.slice(index + 1).some(line => line.includes('"tool_use_id":"' + payload.toolUseID + '"'))
    || createHash('sha256').update(lines[index]!).digest('hex') !== checkpoint.checkpointDigest
    || !binding?.nativeRequestId || binding.nativeRequestId !== payload.nativeRequestId || binding.launch?.incarnationId !== view.incarnationId
    || stableJson(binding.launch) !== stableJson(native.nativeLaunch)) throw new Error('native approval operation/checkpoint/current binding differs')
  const file = (pathname: string, uid: number) => {
    const matches = files?.filter(value => value.path === pathname && value.readerUid === uid) ?? []
    if (matches.length !== 1) throw new Error('native approval checkpoint/actor original is missing')
    const raw = Buffer.from(matches[0].bytesBase64, 'base64')
    if (raw.length > 32 * 1024 * 1024 || createHash('sha256').update(raw).digest('hex') !== matches[0].sha256) throw new Error('native approval file differs')
    return JSON.parse(raw.toString('utf8'))
  }
  const record = file('/home/freshell/provider/.freshell/native-checkpoints/claude/' + view.nativeSessionId + '.json', 65534)
  const actor = file('/run/freshell-host-actor/fresh-agent-state.json', 0), decision = actor.decisions?.[card.decision_id]
  const { profileDigest, ...nativeCheckpoint } = checkpoint
  if (record.schemaVersion !== 1 || record.phase !== 'approval_waiting' || record.nativeSessionId !== view.nativeSessionId
    || record.toolUseID !== payload.toolUseID || record.inputDigest !== checkpoint.inputDigest || record.profileDigest !== profileDigest
    || !/^[a-f0-9]{64}$/.test(profileDigest) || stableJson(record.checkpoint) !== stableJson(nativeCheckpoint)
    || stableJson(record.nativeBinding) !== stableJson(binding) || actor.schemaVersion !== 1 || decision?.state !== 'pending'
    || stableJson(decision.payload) !== stableJson(payload)) throw new Error('native approval persisted checkpoint/actor binding differs')
}

export function validateFreshApprovalDispatch(value: any): void {
  const current = value.currentCard, view = value.afterView
  const dispatches = value.events.filter((event: any) => event.kind === 'provider' && event.data.payload.event?.type === 'freshAgent.permission.dispatch')
  const dispatch = dispatches[0]?.data.payload.event
  if (dispatches.length !== 1 || dispatch.ok !== true || String(dispatch.requestId) !== current.decision_id
    || dispatch.nativeRequestId !== current.payload.nativeRequestId || dispatch.sessionId !== view.nativeSessionId
    || !matchesFreshBrowserFrame(view, value.browserDecision)) throw new Error('native approval current dispatch differs')
}

function validateFreshWriterReplacement(lifecycle: any[], before: any, after: any, store: string, root: string): void {
  const release = lifecycle.findIndex(event => event.event === 'supervisor.recovery.old_writer_released' && event.data?.soulId === before.soulId
    && event.data.incarnationId === before.incarnationId && event.data.containerId === before.containerId && event.data.providerStoreId === store
    && event.data.outcome === 'verified_empty' && event.data.writerState === 'released')
  const preparation = lifecycle.findIndex(event => event.event === 'supervisor.recovery.replacement_writer_prepared' && event.data?.soulId === before.soulId
    && event.data.priorIncarnationId === before.incarnationId && event.data.incarnationId === after.incarnationId && event.data.providerStoreId === store
    && event.data.nativeSessionId === root && event.data.writerState === 'prepared')
  const running = lifecycle.findIndex(event => event.event === 'supervisor.launch_running' && event.data?.soulId === before.soulId
    && event.data.incarnationId === after.incarnationId && event.data.containerId === after.containerId)
  if (release < 0 || preparation <= release || running <= preparation) throw new Error('committed old writer release/preparation/running order differs')
}

export function validateFreshApprovalRecovery(value: any, identity: { soulId: string; nativeSessionId: string; providerStoreId: string }): void {
  const recovery = value.recoveryObservation
  if (!recovery || !Number.isSafeInteger(value.beforeCapturedAt) || !Number.isSafeInteger(value.currentCapturedAt)
    || !Number.isSafeInteger(recovery.requestedAt) || !Number.isSafeInteger(recovery.completedAt)
    || recovery.requestedAt < value.beforeCapturedAt || recovery.completedAt < recovery.requestedAt
    || value.currentCapturedAt < recovery.completedAt) throw new Error('actual intervening approval recovery is missing')
  const { before, after } = recovery
  for (const [allocation, view, native] of [[before, value.beforeView, value.beforeNative], [after, value.afterView, value.currentNative]]) {
    if (allocation.view.soulId !== identity.soulId || allocation.view.nativeSessionId !== identity.nativeSessionId
      || ['soulId', 'nativeSessionId', 'freshAgentSessionId', 'freshAgentSessionType', 'provider', 'incarnationId', 'containerId', 'hostBootId'].some(field => allocation.view[field] !== view[field])
      || view.freshAgentSessionId !== value.beforeView.freshAgentSessionId
      || allocation.writer.providerStoreId !== identity.providerStoreId || allocation.writer.soulId !== identity.soulId
      || allocation.writer.nativeSessionId !== identity.nativeSessionId || allocation.writer.incarnationId !== view.incarnationId
      || allocation.writer.activeClaimCount !== 1 || allocation.writer.globalConflictingClaimCount !== 0
      || allocation.process.native.uid !== 65534 || allocation.process.native.launch.incarnationId !== view.incarnationId
      || allocation.process.native.pid !== native.nativePid || allocation.process.native.executableSha256 !== native.executableSha256) throw new Error('approval recovery current allocation/process/writer differs')
  }
  if (before.volume.providerVolumeName !== after.volume.providerVolumeName) throw new Error('approval recovery provider volume differs')
  if (recovery.kind === 'web_restart') {
    if (value.recovery !== 'web' || ['incarnationId', 'containerId', 'hostBootId'].some(field => before.view[field] !== after.view[field])
      || ['pid', 'startTicks', 'executableSha256'].some(field => before.process.native[field] !== after.process.native[field])) throw new Error('approval web recovery did not retain its live native process')
  } else {
    const kind = recovery.kind === 'session_host_exit' ? 'host' : recovery.kind === 'provider_process_exit' ? 'provider' : null
    if (!kind || value.recovery !== kind || recovery.soulId !== identity.soulId || recovery.nativeSessionId !== identity.nativeSessionId
      || recovery.containerId !== before.view.containerId || recovery.incarnationId !== before.view.incarnationId
      || recovery.nativePid !== before.process.native.pid || recovery.startTicks !== before.process.native.startTicks
      || !Number.isSafeInteger(recovery.exitedAt) || recovery.exitedAt < recovery.requestedAt || recovery.exitedAt > recovery.completedAt
      || (kind === 'host' ? recovery.observation !== 'exact-owned-container-stopped'
        : !['exact-native-process-exited', 'exact-owned-container-stopped'].includes(recovery.observation))
      || before.view.incarnationId === after.view.incarnationId || before.view.containerId === after.view.containerId) throw new Error('approval owned recovery action/exit differs')
    validateFreshWriterReplacement(recovery.lifecycle, before.view, after.view, identity.providerStoreId, identity.nativeSessionId)
  }
}

/** Reopens practical browser/owner observations, rather than treating inventory as execution. */
export function deriveFreshBrowserExecution(original: Record<string, any>, conversation: ObservedNativeConversation): Pick<FreshAgentQualificationRow,
  'ingresses' | 'crashes' | 'pendingApproval' | 'writerProof' | 'isolation' | 'limits' | 'oldEnclosure'> {
  const required = FRESH_AGENT_INGRESS_INVENTORY.map(({ ingress }) => ingress)
  const routes: Record<string, any>[] = original.routes ?? []
  const external = required.filter(id => !['startup-restore', 'auto-resume'].includes(id))
  for (const id of external) {
    const matching = routes.filter(route => route.ingress === id)
    if (matching.length !== 1) throw new Error(`executed ingress ${id} is missing or repeated`)
    const { request, reply, view } = matching[0]!
    if (!view || view.launchState !== 'running' || view.recoveryState !== 'live' || view.freshAgentSessionType !== original.mode
      || !view.nativeIdentityObservation || view.nativeSessionId !== view.nativeIdentityObservation.nativeSessionId) throw new Error(`executed ingress ${id} has no current native activation`)
    if (id === 'history-resume' && request?.type === 'freshAgent.attach') {
      if (!matchesFreshBrowserFrame(view, request)) throw new Error('executed history attach differs')
    } else if (['browser-picker', 'browser-split', 'ws-create', 'history-resume'].includes(id)) {
      const sessionId = id === 'history-resume' ? view.nativeSessionId : view.freshAgentSessionId
      if (request?.type !== 'freshAgent.create' || request.sessionType !== original.mode || !request.requestId
        || reply?.type !== 'freshAgent.created' || reply.requestId !== request.requestId || reply.sessionId !== sessionId) throw new Error(`executed ingress ${id} request/reply differs`)
      if (id === 'history-resume' && (request.sessionRef?.sessionId !== view.nativeSessionId
        || request.sessionRef.provider !== MODE_CONTRACT[original.mode as QualifiableFreshAgentMode].provider)) throw new Error('history resume did not use the actual native root')
    } else if (id === 'ws-attach') {
      // Successful attach has no wire acknowledgment. The exact current activation is the observed outcome.
      if (request?.type !== 'freshAgent.attach' || !matchesFreshBrowserFrame(view, request)) throw new Error('executed ingress ws-attach differs')
    } else {
      validateFreshBrowserAlias(matching[0]!, { ...conversation, provider: MODE_CONTRACT[conversation.mode as QualifiableFreshAgentMode].provider })
      const split = id.endsWith('split')
      if (request?.method !== 'POST' || (split ? !/^\/api\/panes\/[^/]+\/split$/.test(request.path) : request.path !== '/api/tabs')
        || !reply?.paneId || reply.sessionId !== view.nativeSessionId) throw new Error(`executed ingress ${id} request/reply differs`)
    }
  }
  const allocations = original.allocations ?? []
  if (allocations.length !== 2) throw new Error('two observed native allocations required')
  const [main, other] = allocations
  for (const route of routes) {
    const owned = route.ingress === 'browser-split' ? other : main
    if (['soulId', 'nativeSessionId', 'freshAgentSessionId', 'freshAgentSessionType', 'provider'].some(field => route.view[field] !== owned.view[field])) {
      throw new Error('executed browser route differs from its owned allocation')
    }
    if (['history-resume', 'ws-attach'].includes(route.ingress) && route.request.type === 'freshAgent.attach'
      && !sameFreshBrowserActivation(route.view, routes.find(value => value.ingress === 'browser-picker')?.view)) {
      throw new Error('browser attach differs from its original create activation')
    }
  }
  for (const allocation of allocations) {
    const { view, writer, process, volume } = allocation
    if (view.freshAgentSessionType !== original.mode || view.launchState !== 'running' || view.recoveryState !== 'live'
      || writer.soulId !== view.soulId || writer.incarnationId !== view.incarnationId || writer.nativeSessionId !== view.nativeSessionId
      || writer.activeClaimCount !== 1 || writer.globalConflictingClaimCount !== 0 || !volume.providerVolumeName
      || process.native.launch.incarnationId !== view.incarnationId || process.native.uid !== 65534 || process.native.pid <= 1) throw new Error('observed allocation native process/writer differs')
  }
  if (main.view.soulId !== conversation.soulId || main.writer.providerStoreId !== conversation.providerStoreId
    || main.view.nativeSessionId !== conversation.nativeSessionId) throw new Error('browser execution main allocation differs from native collection')
  for (const field of ['soulId', 'incarnationId', 'containerId', 'nativeSessionId']) {
    if (main.view[field] === other.view[field]) throw new Error(`independent allocation ${field} differs`)
  }
  if (main.writer.providerStoreId === other.writer.providerStoreId || main.volume.providerVolumeName === other.volume.providerVolumeName) throw new Error('independent provider store/volume differs')
  const lifecycle: Record<string, any>[] = original.lifecycle ?? []
  const target = (event: Record<string, any>, name: string) => event.event === name && event.data?.soulId === conversation.soulId
  const releases = lifecycle.filter(event => target(event, 'supervisor.recovery.old_writer_released'))
  const prepared = lifecycle.filter(event => target(event, 'supervisor.recovery.replacement_writer_prepared'))
  for (const [index] of conversation.stages.entries()) {
    if (index === 0) continue
    validateFreshWriterReplacement(lifecycle, original.stageViews[index - 1], original.stageViews[index], conversation.providerStoreId, conversation.nativeSessionId)
  }
  if (!lifecycle.some(event => target(event, 'supervisor.runtime_observer.recovery_scheduled'))) throw new Error('automatic recovery was not observed')
  const stable = (before: any, after: any) => ['soulId', 'incarnationId', 'containerId', 'nativeSessionId'].every(field => before.view[field] === after.view[field])
    && ['pid', 'startTicks', 'executableSha256'].every(field => before.process.native[field] === after.process.native[field])
  const web = (original.webRestarts ?? []).find((restart: any) => restart.before.view.soulId === conversation.soulId && stable(restart.before, restart.after))
  if (!web) throw new Error('web restart did not retain the observed live native process')
  const startup = (original.supervisorRestarts ?? []).find((restart: any) => restart.before.soulId === conversation.soulId
    && ['soulId', 'incarnationId', 'containerId', 'nativeSessionId'].every(field => restart.before[field] === restart.after[field])
    && restart.lifecycle.some((event: any) => event.event === 'supervisor.startup_scan.finished' && event.data.scanned > 0))
  if (!startup) throw new Error('actual supervisor startup restore is missing')
  const approvals = original.approvals ?? []
  let pendingApproval: FreshAgentQualificationRow['pendingApproval'] = { supported: false }
  if (MODE_CONTRACT[original.mode as QualifiableFreshAgentMode].pendingApproval) {
    for (const recovery of ['web', 'host', 'provider']) for (const allowed of [true, false]) {
      const cases = approvals.filter((value: any) => value.recovery === recovery && value.allowed === allowed)
      if (cases.length !== 1) throw new Error('native solo Bash allow/deny recovery matrix is incomplete')
      const value = cases[0], old = value.beforeCard, current = value.currentCard
      validateFreshApprovalRecovery(value, { soulId: other.view.soulId, nativeSessionId: other.view.nativeSessionId, providerStoreId: other.writer.providerStoreId })
      validateFreshApprovalCheckpoint(old, value.beforeNative, value.beforeFiles, value.beforeView, value.command)
      validateFreshApprovalCheckpoint(current, value.currentNative, value.currentFiles, value.afterView, value.command)
      validateFreshApprovalDispatch(value)
      if (old.decision_id !== current.decision_id || old.payload.tool.name !== 'Bash' || old.payload.tool.input.command !== value.command
        || stableJson(old.payload.nativeCheckpoint) !== stableJson(current.payload.nativeCheckpoint)
        || current.payload.nativeCheckpoint.nativeSessionId !== value.nativeRoot || current.payload.toolUseID !== old.payload.toolUseID
        || current.payload.nativeBinding?.launch.incarnationId !== value.afterView.incarnationId
        || (recovery === 'web' ? old.payload.nativeRequestId !== current.payload.nativeRequestId : old.payload.nativeRequestId === current.payload.nativeRequestId)
        || value.beforeEffectCount !== 0 || value.currentEffectCount !== 0
        || value.beforeNative.nativeRoot !== value.nativeRoot || value.currentNative.nativeRoot !== value.nativeRoot
        || value.beforeNative.executableSha256 !== other.process.native.executableSha256
        || value.currentNative.executableSha256 !== value.beforeNative.executableSha256
        || value.beforeNative.version?.match(/\b\d+\.\d+\.\d+\b/)?.[0] !== main.process.version || value.currentNative.version !== value.beforeNative.version
        || value.beforeNative.nativeCwd !== value.currentNative.nativeCwd
        || !nativeCheckpointTranscriptRetained(value.beforeNative, value.currentNative, old.payload.toolUseID)) throw new Error('native solo Bash current checkpoint/input/profile differs')
      observeNativeSoloBashOutcome({ nativeRoot: value.nativeRoot, toolUseID: old.payload.toolUseID, allowed, observed: value.events, effectCount: value.effectCount })
      if (value.browserDecision?.type !== 'freshAgent.approval.respond' || String(value.browserDecision.requestId) !== current.decision_id
        || value.browserDecision.decision?.behavior !== (allowed ? 'allow' : 'deny') || value.recheckedEffectCount !== value.effectCount) throw new Error('native decision dispatch/effect replay differs')
    }
    pendingApproval = { supported: true, survivedWebRestart: approvals.some((value: any) => value.recovery === 'web'),
      survivedHostRecovery: approvals.some((value: any) => value.recovery === 'host'), resolvedExactlyOnce: approvals.every((value: any) => value.effectCount === (value.allowed ? 1 : 0)),
      decisionIdHash: createHash('sha256').update(approvals.map((value: any) => value.beforeCard.decision_id).join('\n')).digest('hex') }
  } else if (approvals.length) throw new Error('unsupported adapter must not invent native approvals')
  const last = conversation.stages.at(-1)!
  return { ingresses: required, crashes: { web: ['abrupt_restart'], host: conversation.stages.slice(1).map(stage => stage.stage === 'after_session_host_crash' ? 'session_host_exit' : 'provider_process_exit') }, pendingApproval,
    writerProof: { activeWriterCount: main.writer.activeClaimCount, conflictingWriterCount: main.writer.globalConflictingClaimCount,
      dispatchCountForPrompt: conversation.stages.filter(stage => stage.requestId === last.requestId).length,
      completionCountForPrompt: nativeCompletedTurnProofs(conversation).filter(turn => turn.turnId === nativeCompletedTurnProofs(conversation).at(-1)!.turnId).length },
    isolation: { providerVolumeNameHash: createHash('sha256').update(main.volume.providerVolumeName).digest('hex'), enclosureIdHash: createHash('sha256').update(main.view.containerId).digest('hex'),
      independentProviderStore: main.writer.providerStoreId !== other.writer.providerStoreId, independentEnclosure: main.view.containerId !== other.view.containerId },
    limits: main.limits, oldEnclosure: { verifiedEmptyBeforeResume: releases.length >= conversation.stages.length - 1,
      writerClaimReleasedBeforeResume: prepared.length >= conversation.stages.length - 1 } }
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
  validateBrowserExecutions(expectedDir, input.rows, observed, input.candidateSha, input.receiptRunId, input.runtimeImage)

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
  validateBrowserExecutions(evidenceDir, assertion.rows, observed, input.candidateSha, receipt.receiptRunId, input.expectedRuntimeImage)
  return {
    receipt: receipt as FreshAgentQualificationReceiptV1,
    rows: assertion.rows,
  }
}


function validateBrowserExecutions(evidenceDir: string, rows: FreshAgentQualificationRow[], observed: ObservedNativeConversation[], candidateSha: string, runId: string, runtimeImage: string): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(evidenceDir, NATIVE_RECOVERY_ORIGINALS_FILE), 'utf8'))
  for (const [index, row] of rows.entries()) {
    if (!row.executionOriginal) throw new Error('fresh browser execution original is missing')
    const original = JSON.parse(readNativeOriginalReference(evidenceDir, row.executionOriginal).bytes.toString('utf8'))
    for (const [field, expected] of Object.entries({ candidateSha, runId, runtimeImage })) stringEqual(original.execution?.[field], expected, 'browser execution ' + field)
    stringEqual(original.mode, row.mode, 'browser execution mode')
    original.stageViews = manifest.conversations[index].stages.map((stage: any) => {
      const launch = JSON.parse(readNativeOriginalReference(evidenceDir, stage.launch).bytes.toString('utf8'))
      return launch.response?.data?.view ?? launch.response?.result?.Ok?.data?.view
    })
    const ui = object(original.ui, 'actual browser native turn')
    const view = object(ui.view, 'actual browser send activation')
    const split = original.routes.find((route: any) => route.ingress === 'browser-split')
    const material = (reference: unknown) => nativeMaterial(evidenceDir, { nativeFile: reference }, row.provider, ui.nativeRoot)
    const before = ui.boundary ? material(ui.boundary) : { history: { turns: [] }, inputs: [] }, after = material(ui.after)
    const newInputs = after.inputs.filter(input => !before.inputs.some(prior => prior.id === input.id))
    const last = after.history.turns.at(-1)!, evidence = last?.nativeEvidence
    if (ui.nativeRoot !== original.allocations[1].view.nativeSessionId || ui.request?.type !== 'freshAgent.send'
      || ui.request.text !== 'Reply ready. Do not use tools.' || !matchesFreshBrowserFrame(view, ui.request)
      || ui.nativeRoot !== view.nativeSessionId || ui.provider !== row.provider
      || ['soulId', 'nativeSessionId', 'freshAgentSessionId', 'freshAgentSessionType', 'provider'].some(field => view[field] !== original.allocations[1].view[field])
      || !sameFreshBrowserActivation(view, split?.view)
      || ui.reply?.type !== 'freshAgent.send.accepted' || ui.reply.requestId !== ui.request.requestId
      || !ui.request.requestId || !matchesFreshBrowserSendAccepted(view, ui.reply) || before.history.turns.length !== ui.beforeTurns || after.history.turns.length !== before.history.turns.length + 1
      || newInputs.length !== 1 || newInputs[0]!.text !== ui.request.text || evidence?.kind !== 'identified_message'
      || (row.provider === 'codex' ? evidence.turnId !== newInputs[0]!.id : evidence.parentMessageId !== newInputs[0]!.id)
      || !hasSuccessfulNativeAnswer(last, row.provider) || last.toolCalls.length
      || stableJson(after.history.turns.slice(0, before.history.turns.length)) !== stableJson(before.history.turns)) throw new Error('actual browser native no-tool completion differs')
    const derived = deriveFreshBrowserExecution(original, observed[index]!)
    for (const [field, value] of Object.entries(derived)) {
      if (stableJson(row[field]) !== stableJson(value)) throw new Error('browser execution derived ' + field + ' differs')
    }
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
      if (row.mode === 'freshopencode' && (!Array.isArray(spec.providerSecretReferences) || spec.providerSecretReferences.length !== 0)) throw new Error('free accepted profile has missing or nonempty provider grant references')
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
      const expectedProvider = row.provider === 'claude' ? 'anthropic' : row.mode === 'freshopencode' ? 'opencode' : 'openai'
      const expectedModel = row.provider === 'claude' ? 'claude-haiku-4-5-20251001' : row.mode === 'freshopencode' ? 'big-pickle' : 'gpt-5.6-luna'
      stringEqual(stage.profile.provider, expectedProvider, 'native completed profile provider')
      stringEqual(stage.profile.observedModel, expectedModel, 'native completed profile model')
      if (stage.profile.effort !== null && stage.profile.effort !== row.effort) throw new Error('native observed effort differs from intended profile')
    }
  }
}

export function nativeCompletedTurnProofs(conversation: ObservedNativeConversation): NativeTurnProof[] {
  return conversation.stages.map(stage => {
    if (stage.nativeEvidence.kind !== 'identified_message') throw new Error('fresh native completion requires actual native message IDs')
    return { turnId: stage.nativeEvidence.turnId, assistantMessageId: stage.nativeEvidence.messageId, completionKind: 'provider_native_completed' }
  })
}

function validateDerivedNativeRows(rows: FreshAgentQualificationRow[], observed: ObservedNativeConversation[]): void {
  for (const [index, row] of rows.entries()) {
    const conversation = observed[index]!
    for (const field of ['mode', 'soulId', 'providerStoreId', 'nativeSessionId'] as const) stringEqual(conversation[field], row[field], `native ${field}`)
    const derived = nativeCompletedTurnProofs(conversation)
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
