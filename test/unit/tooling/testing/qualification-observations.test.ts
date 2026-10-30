// @vitest-environment node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const { DatabaseSync }: typeof import('node:sqlite') = createRequire(import.meta.url)('node:sqlite')
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildFreshAgentQualificationReceipt, validateFreshAgentQualificationReceipt, type FreshAgentQualificationRow } from '../../../../scripts/testing/fresh-agent-qualification-receipt.js'
import { FRESH_AGENT_INGRESS_INVENTORY } from '../../../../scripts/testing/fresh-agent-ingress-inventory.js'
import { deriveNativeRecoveryOriginals, nativeNamespaceAccessMatches, nativeRecoveryValidationDiagnostic, NativeRecoveryValidationError, type NativeRecoveryStage } from '../../../../scripts/testing/qualification-observations.js'
import { ManagedRuntimeOwner } from '../../../../scripts/testing/runtime-sandbox.js'

const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const candidateSha = 'a'.repeat(40), runtimeImage = `sha256:${'b'.repeat(64)}`, receiptRunId = 'native-originals-001'
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

describe('selected native free access observation', () => {
  it('keeps authenticated paid access and free selected system-CA TLS separate', () => {
    const paid = { httpsStatus: 200, tlsVerifyMode: 2, tlsCheckHostname: true }
    const free = { ...paid, httpsStatus: null, freeModelAccess: { source: 'native-config-providers', providerId: 'opencode', modelId: 'big-pickle',
      endpoint: 'https://unit-free.invalid/v1', ca: 'system-default', peerCertificateSha256: 'a'.repeat(64) } }
    expect(nativeNamespaceAccessMatches(paid, 'opencode')).toBe(true)
    expect(nativeNamespaceAccessMatches(paid, 'freshcodex')).toBe(true)
    expect(nativeNamespaceAccessMatches(free, 'freshopencode')).toBe(true)
    expect(nativeNamespaceAccessMatches(paid, 'freshopencode')).toBe(false)
    expect(nativeNamespaceAccessMatches(free, 'opencode')).toBe(false)
    for (const endpoint of ['http://unit.invalid', 'https://private@unit.invalid', 'https://unit.invalid/?token=private', 'https://unit.invalid/#private', 'unknown']) {
      expect(nativeNamespaceAccessMatches({ ...free, freeModelAccess: { ...free.freeModelAccess, endpoint } }, 'freshopencode')).toBe(false)
    }
  })
})

describe('native recovery validation diagnostics', () => {
  it.each(['after_session_host_crash', 'after_provider_process_crash'] as const)('projects only the fixed missing-recall facts at %s', stage => {
    const expected = { code: 'recovery_nonce_not_recalled', stage }
    const failure = new NativeRecoveryValidationError(stage)
    expect(nativeRecoveryValidationDiagnostic(failure)).toEqual(expected)
    Object.assign(failure, { diagnostic: { ...expected, message: 'synthetic private response', cause: { content: 'synthetic private input' }, stack: 'synthetic private trace' } })
    expect(nativeRecoveryValidationDiagnostic(failure)).toEqual(expected)
    expect(nativeRecoveryValidationDiagnostic(Object.assign(new Error('synthetic private error'), {
      name: 'NativeRecoveryValidationError', diagnostic: expected,
    }))).toBeUndefined()
  })

  it.each([
    null,
    { code: 'synthetic_private_code', stage: 'after_session_host_crash' },
    { code: 'recovery_nonce_not_recalled', stage: 'initial' },
    { code: 'recovery_nonce_not_recalled', stage: 'synthetic_private_stage' },
  ])('rejects a mutated diagnostic outside the fixed classifications (%#)', diagnostic => {
    const failure = Object.assign(new NativeRecoveryValidationError('after_session_host_crash'), { diagnostic })
    expect(nativeRecoveryValidationDiagnostic(failure)).toBeUndefined()
  })
})


function browserExecutionFixture(current: FreshAgentQualificationRow, stages: any[], evidenceDir: string, write: (name: string, value: any) => { path: string; sha256: string }, prefix: string) {
  const read = (reference: any) => JSON.parse(fs.readFileSync(path.join(evidenceDir, reference.path), 'utf8'))
  const stageViews = stages.map(stage => read(stage.launch).response.data.view)
  const view = { ...stageViews.at(-1), provider: current.mode === 'kilroy' ? 'kilroy' : current.provider, freshAgentSessionType: current.mode, freshAgentSessionId: current.nativeSessionId }
  const native = read(read(stages.at(-1).profile).process)
  const allocation = { view, writer: { soulId: current.soulId, incarnationId: view.incarnationId, nativeSessionId: current.nativeSessionId,
    providerStoreId: current.providerStoreId, activeClaimCount: 1, globalConflictingClaimCount: 0 }, volume: { providerVolumeName: 'owned-volume' }, process: native, limits: current.limits }
  const otherRoot = 'other-' + current.nativeSessionId
  const other = structuredClone(allocation)
  Object.assign(other.view, { soulId: 'other-soul', incarnationId: 'other-inc', containerId: 'other-container', nativeSessionId: otherRoot, freshAgentSessionId: otherRoot,
    nativeIdentityObservation: { ...view.nativeIdentityObservation, nativeSessionId: otherRoot, incarnationId: 'other-inc' } })
  Object.assign(other.writer, { soulId: other.view.soulId, incarnationId: other.view.incarnationId, nativeSessionId: otherRoot, providerStoreId: 'other-store' })
  other.volume.providerVolumeName = 'other-volume'; other.process.native.launch.incarnationId = other.view.incarnationId
  const routes = FRESH_AGENT_INGRESS_INVENTORY.filter(({ ingress }) => !['startup-restore', 'auto-resume'].includes(ingress)).map(({ ingress }) => {
    const target = ingress === 'browser-split' ? other.view : view
    const requestId = 'create-' + ingress
    if (['browser-picker', 'browser-split', 'ws-create', 'history-resume'].includes(ingress)) return { ingress, view: target,
      request: { type: 'freshAgent.create', requestId, sessionType: current.mode, ...(ingress === 'history-resume' ? { sessionRef: { provider: current.provider, sessionId: target.nativeSessionId } } : {}) },
      reply: { type: 'freshAgent.created', requestId, sessionId: target.freshAgentSessionId } }
    if (ingress === 'ws-attach') return { ingress, view: target, request: { type: 'freshAgent.attach', sessionId: target.freshAgentSessionId } }
    return { ingress, view: target, writer: structuredClone(allocation.writer), request: { method: 'POST', path: ingress.endsWith('split') ? '/api/panes/actual-pane/split' : '/api/tabs', body: { agent: current.mode, sessionRef: { provider: current.provider, sessionId: target.nativeSessionId } } },
      reply: { paneId: 'actual-pane', sessionId: target.freshAgentSessionId } }
  })
  const lifecycle: any[] = [{ event: 'supervisor.runtime_observer.recovery_scheduled', data: { soulId: current.soulId } }]
  for (const index of [1, 2]) {
    lifecycle.push({ event: 'supervisor.recovery.old_writer_released', data: { soulId: current.soulId, incarnationId: stageViews[index - 1].incarnationId,
      containerId: stageViews[index - 1].containerId, providerStoreId: current.providerStoreId, outcome: 'verified_empty', writerState: 'released' } },
    { event: 'supervisor.recovery.replacement_writer_prepared', data: { soulId: current.soulId, priorIncarnationId: stageViews[index - 1].incarnationId,
      incarnationId: stageViews[index].incarnationId, providerStoreId: current.providerStoreId, nativeSessionId: current.nativeSessionId, writerState: 'prepared' } },
    { event: 'supervisor.launch_running', data: { soulId: current.soulId, incarnationId: stageViews[index].incarnationId, containerId: stageViews[index].containerId } })
  }
  const prompt = 'Reply ready. Do not use tools.'
  let after: { path: string; sha256: string }
  const firstFile = path.join(evidenceDir, stages[0].nativeFile.path)
  if (current.provider === 'opencode') {
    const target = path.join(evidenceDir, prefix, 'ui', 'opencode.db'); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(firstFile, target)
    const db = new DatabaseSync(target)
    db.prepare('UPDATE session SET id=?').run(otherRoot)
    for (const table of ['message', 'part']) db.prepare('UPDATE ' + table + ' SET session_id=?').run(otherRoot)
    db.prepare('UPDATE part SET data=? WHERE message_id=?').run(JSON.stringify({ type: 'text', text: prompt }), 'user-0')
    db.close(); after = { path: path.relative(evidenceDir, target), sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex') }
  } else {
    const rows = fs.readFileSync(firstFile, 'utf8').trim().split('\n').map(line => JSON.parse(line.replaceAll(current.nativeSessionId || 'invalid-root', otherRoot)))
    for (const row of rows) {
      if (row.type === 'user' && row.message.role === 'user') row.message.content = prompt
      if (row.type === 'event_msg' && row.payload.type === 'user_message') row.payload.message = prompt
    }
    after = write(prefix + '/ui/' + (current.provider === 'codex' ? 'rollout-' : '') + otherRoot + '.jsonl', rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  }
  const ui = { provider: current.provider, nativeRoot: otherRoot, view: structuredClone(other.view), beforeTurns: 0, after,
    request: { type: 'freshAgent.send', requestId: 'actual-ui-send', sessionId: otherRoot, text: prompt },
    reply: { type: 'freshAgent.send.accepted', requestId: 'actual-ui-send', sessionId: otherRoot } }
  const approvals: any[] = []
  if (['freshclaude', 'kilroy'].includes(current.mode)) for (const recovery of ['web', 'host', 'provider']) for (const allowed of [true, false]) {
    const decisionId = 'decision-' + current.mode + '-' + recovery + '-' + allowed, toolUseID = 'toolu_' + decisionId
    const command = "printf 'effect\\n' >> '/owned/effect-" + decisionId + ".jsonl'"
    const inputDigest = createHash('sha256').update(JSON.stringify({ command })).digest('hex')
    const assistant = { type: 'assistant', uuid: 'assistant-' + decisionId, version: '2.1.237', sessionId: otherRoot, message: { id: 'message-' + decisionId, content: [{ type: 'tool_use', id: toolUseID, name: 'Bash', input: { command } }] } }
    const deferred = { type: 'attachment', uuid: 'checkpoint-' + decisionId, version: '2.1.237', sessionId: otherRoot, attachment: { type: 'hook_deferred_tool', hookEvent: 'PreToolUse', toolUseID, toolName: 'Bash', toolInput: { command } } }
    const bytes = Buffer.from(JSON.stringify(assistant) + '\n' + JSON.stringify(deferred) + '\n')
    const checkpoint = { nativeSessionId: otherRoot, toolUseID, inputDigest, profileDigest: 'a'.repeat(64), toolName: 'Bash', checkpointUuid: deferred.uuid, assistantUuid: assistant.uuid, nativeVersion: '2.1.237', checkpointDigest: createHash('sha256').update(JSON.stringify(deferred)).digest('hex') }
    const beforeNative = { nativeRoot: otherRoot, version: current.providerVersion + ' (Claude Code)', executableSha256: 'd'.repeat(64), nativeCwd: '/owned/workspace', nativePid: other.process.native.pid, transcript: { identity: ['1', '2'], completeEof: true, bytesBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') } }
    const beforeCard = { decision_id: decisionId, payload: { tool: { name: 'Bash', input: { command } }, toolUseID, nativeCheckpoint: checkpoint,
      nativeRequestId: 'old-' + decisionId, nativeBinding: { nativeRequestId: 'old-' + decisionId, queryGeneration: 1, launch: { incarnationId: 'other-inc', launchNonce: 'old-' + decisionId } } } }
    const currentCard = structuredClone(beforeCard), afterView = { ...structuredClone(other.view), incarnationId: recovery === 'web' ? 'other-inc' : 'recovered-' + decisionId }
    afterView.nativeIdentityObservation.incarnationId = afterView.incarnationId
    currentCard.payload.nativeBinding.launch.incarnationId = afterView.incarnationId
    if (recovery !== 'web') currentCard.payload.nativeRequestId = 'new-' + decisionId
    currentCard.payload.nativeBinding.nativeRequestId = currentCard.payload.nativeRequestId
    const currentNative = structuredClone(beforeNative)
    Object.assign(beforeNative, { nativeLaunch: beforeCard.payload.nativeBinding.launch })
    Object.assign(currentNative, { nativeLaunch: currentCard.payload.nativeBinding.launch })
    const afterAllocation = structuredClone(other)
    afterAllocation.view = afterView
    afterAllocation.writer.incarnationId = afterView.incarnationId
    afterAllocation.process.native.launch.incarnationId = afterView.incarnationId
    if (recovery !== 'web') { afterView.containerId = 'recovered-container-' + decisionId; afterView.hostBootId = 'recovered-boot-' + decisionId; afterAllocation.process.native.pid += 100; afterAllocation.process.native.startTicks = '200' }
    currentNative.nativePid = afterAllocation.process.native.pid
    const auxiliaryLifecycle = [{ event: 'supervisor.recovery.old_writer_released', data: { soulId: other.view.soulId, incarnationId: other.view.incarnationId, containerId: other.view.containerId, providerStoreId: other.writer.providerStoreId, outcome: 'verified_empty', writerState: 'released' } },
      { event: 'supervisor.recovery.replacement_writer_prepared', data: { soulId: other.view.soulId, priorIncarnationId: other.view.incarnationId, incarnationId: afterView.incarnationId, providerStoreId: other.writer.providerStoreId, nativeSessionId: otherRoot, writerState: 'prepared' } },
      { event: 'supervisor.launch_running', data: { soulId: other.view.soulId, incarnationId: afterView.incarnationId, containerId: afterView.containerId } }]
    const recoveryObservation = { kind: recovery === 'web' ? 'web_restart' : recovery === 'host' ? 'session_host_exit' : 'provider_process_exit', requestedAt: 11, completedAt: 13, exitedAt: 12,
      soulId: other.view.soulId, nativeSessionId: otherRoot, incarnationId: other.view.incarnationId, containerId: other.view.containerId, nativePid: other.process.native.pid, startTicks: other.process.native.startTicks,
      observation: recovery === 'provider' ? 'exact-native-process-exited' : 'exact-owned-container-stopped', before: structuredClone(other), after: afterAllocation, lifecycle: recovery === 'web' ? [] : auxiliaryLifecycle }
    const files = (card: any) => {
      const { profileDigest, ...nativeCheckpoint } = card.payload.nativeCheckpoint
      return [{ path: '/home/freshell/provider/.freshell/native-checkpoints/claude/' + otherRoot + '.json', readerUid: 65534,
        value: { schemaVersion: 1, phase: 'approval_waiting', checkpoint: nativeCheckpoint, nativeSessionId: otherRoot, toolUseID, inputDigest, profileDigest, nativeBinding: card.payload.nativeBinding } },
      { path: '/run/freshell-host-actor/fresh-agent-state.json', readerUid: 0, value: { schemaVersion: 1, decisions: { [card.decision_id]: { state: 'pending', payload: card.payload } } } }]
        .map(({ value, ...file }) => { const bytes = Buffer.from(JSON.stringify(value)); return { ...file, bytesBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') } })
    }
    const events = [{ kind: 'provider', data: { payload: { event: { type: 'freshAgent.permission.dispatch', ok: true, sessionId: otherRoot, requestId: decisionId, nativeRequestId: currentCard.payload.nativeRequestId } } } },
      { kind: 'provider', data: { payload: { event: { type: 'freshAgent.tool.result', content: [{ tool_use_id: toolUseID, is_error: !allowed }] } } } },
      { kind: 'provider', data: { payload: { event: { type: 'freshAgent.result', nativeSessionId: otherRoot, isError: false } } } }]
    approvals.push({ recovery, allowed, nativeRoot: otherRoot, command, beforeCard, currentCard, beforeView: structuredClone(other.view), beforeNative, currentNative, beforeFiles: files(beforeCard), currentFiles: files(currentCard),
      beforeCapturedAt: 10, currentCapturedAt: 14, recoveryObservation, beforeEffectCount: 0, currentEffectCount: 0, afterView, effectCount: allowed ? 1 : 0, recheckedEffectCount: allowed ? 1 : 0, events,
      browserDecision: { type: 'freshAgent.approval.respond', sessionId: otherRoot, requestId: decisionId, decision: { behavior: allowed ? 'allow' : 'deny' } } })
  }
  const execution = { mode: current.mode, routes, ui, allocations: [allocation, other], stageViews, lifecycle,
    webRestarts: [{ before: allocation, after: structuredClone(allocation) }],
    supervisorRestarts: [{ before: view, after: structuredClone(view), lifecycle: [{ event: 'supervisor.startup_scan.finished', data: { scanned: 2 } }] }], approvals }
  return write(prefix + '/execution.json', execution)
}

function fixture(missingHostCompletion = false) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qualification-originals-')); roots.push(repoRoot)
  const evidenceDir = path.join(repoRoot, '.runtime-evidence', candidateSha, receiptRunId)
  fs.mkdirSync(evidenceDir, { recursive: true }); fs.mkdirSync(path.join(repoRoot, 'docker/runtime'), { recursive: true })
  const write = (name: string, value: unknown) => {
    const file = path.join(evidenceDir, name); fs.mkdirSync(path.dirname(file), { recursive: true })
    const captured = typeof value === 'object' && value !== null ? { execution: { candidateSha, runId: receiptRunId, runtimeImage }, ...value } : value
    fs.writeFileSync(file, typeof captured === 'string' ? captured : JSON.stringify(captured), { mode: 0o600 })
    return { path: name, sha256: digest(fs.readFileSync(file)) }
  }
  fs.writeFileSync(path.join(repoRoot, 'docker/runtime/provider-versions.json'), JSON.stringify({ providers: { codex: { version: '0.147.0' } } }))
  write('manifest.json', { execution: { candidateSha, runId: receiptRunId } })
  write('build.json', { candidateSha, runtimeImage, freshAgentQualificationBuild: { kind: 'production', serverFeatures: ['managed-runtime-v1'], sessionHostFeatures: [], selectedModes: ['freshcodex'], fixtureModes: [] }, binaries: { server: { sha256: '1'.repeat(64) }, supervisor: { sha256: '2'.repeat(64) }, sessionHost: { sha256: '3'.repeat(64) } } })
  write('broker.jsonl', JSON.stringify({ unsafeAttempt: false }) + '\n'); write('cleanup.json', { ok: true, errors: [], unsafeBrokerAttempts: [] })
  const nativeSessionId = '11111111-1111-4111-8111-111111111111', nonce = 'owned-memory-112233445566778899'
  const rows: FreshAgentQualificationRow[] = [{ mode: 'freshcodex', provider: 'codex', providerVersion: '0.147.0', model: 'gpt-5.6-luna', effort: 'low', runtimeVariant: 'codex-app-server', actualProviderProcess: true, fixtureTransport: false,
    ingresses: FRESH_AGENT_INGRESS_INVENTORY.map(({ ingress }) => ingress), soulId: 'soul-freshcodex', providerStoreId: 'store-freshcodex', nativeSessionId,
    completedNativeTurns: [0, 1, 2].map(index => ({ turnId: `turn-${index}`, assistantMessageId: `assistant-${index}`, completionKind: 'provider_native_completed' })), noToolRecall: true,
    crashes: { web: ['abrupt_restart'], host: ['session_host_exit', 'provider_process_exit'] }, pendingApproval: { supported: false }, writerProof: { activeWriterCount: 1, conflictingWriterCount: 0, dispatchCountForPrompt: 1, completionCountForPrompt: 1 },
    isolation: { providerVolumeNameHash: digest('owned-volume'), enclosureIdHash: digest('container-2'), independentProviderStore: true, independentEnclosure: true }, limits: { cpuMax: '50000 100000', memoryMax: '268435456', swapMax: '0', pidsMax: '64' }, oldEnclosure: { verifiedEmptyBeforeResume: true, writerClaimReleasedBeforeResume: true } }]
  const priorRows: unknown[] = []
  const stages = ['initial', 'after_session_host_crash', 'after_provider_process_crash'].map((stage, index) => {
    const prompt = index === 0 ? `Remember ${nonce}. Reply stored. Do not use tools.` : 'Recall the remembered marker. Do not use tools.'
    const base = 1_780_000_000_000 + index * 10_000
    const currentRows = [
      { type: 'turn_context', payload: { turn_id: `turn-${index}`, model: 'gpt-5.6-luna', effort: 'low' } },
      { type: 'event_msg', timestamp: new Date(base + 2_000).toISOString(), payload: { type: 'user_message', message: prompt } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', id: `assistant-${index}`, content: [{ type: 'output_text', text: index === 0 ? 'stored' : nonce }] } },
      ...((missingHostCompletion && index === 1) ? [] : [{ type: 'event_msg', timestamp: new Date(base + 3_000).toISOString(), payload: { type: 'task_complete', turn_id: `turn-${index}`, last_agent_message: index === 0 ? 'stored' : nonce } }])]
    priorRows.push(...currentRows)
    const sourceRows = [{ type: 'session_meta', payload: { id: nativeSessionId, model_provider: 'openai' } }, ...priorRows]
    const nativeFile = write(`stage-${index}/rollout-${nativeSessionId}.jsonl`, sourceRows.map(row => JSON.stringify(row)).join('\n') + '\n')
    const launch = write(`stage-${index}/launch.json`, { capturedAt: base + 1_000, response: { data: { view: { soulId: rows[0]!.soulId, providerStoreId: rows[0]!.providerStoreId, nativeSessionId, incarnationId: `inc-${index}`, containerId: `container-${index}`, hostBootId: `boot-${index}`, executionGeneration: index + 1, launchState: 'running', recoveryState: 'live', nativeIdentityObservation: { nativeSessionId, incarnationId: `inc-${index}`, launchNonce: `launch-${index}`, evidenceRevision: index, source: 'fresh_provider_handshake', evidenceDigest: 'c'.repeat(64) } } } } })
    const request = write(`stage-${index}/request.json`, { sentAt: base + 2_000, requestId: `request-${index}`, request: { method: 'fresh_agent_send', params: { soulId: rows[0]!.soulId, text: prompt } }, reply: { data: { submittedTurnId: `turn-${index}` } } })
    const crash = index ? write(`stage-${index}/crash.json`, { kind: index === 1 ? 'session_host_exit' : 'provider_process_exit', containerId: `container-${index - 1}`, incarnationId: `inc-${index - 1}`, requestedAt: base - 2_000, exitedAt: base - 1_000 }) : undefined
    const nativeLaunch = { incarnationId: `inc-${index}`, launchNonce: `launch-${index}`, executionGeneration: index + 1, evidenceRevision: index }
    const namespace = write(`stage-${index}/namespace.json`, { uid: 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true, httpsStatus: 200, tlsVerifyMode: 2, tlsCheckHostname: true, nativeRoot: nativeSessionId, nativeCwd: '/owned/workspace', nativePid: 55 + index, nativeLaunch, ownedProbe: { containerId: `container-${index}`, nativePid: 55 + index, capturedAt: base + 1_500 }, executableSha256: 'd'.repeat(64), profileSha256: 'e'.repeat(64) })
    const bytes = fs.readFileSync(path.join(evidenceDir, nativeFile.path))
    const store = write(`stage-${index}/store.json`, { containerId: `container-${index}`, providerVolumeName: 'owned-volume', snapshot: { path: '/owned/rollout.jsonl', identity: ['1', '2'], completeEof: true, bytesBase64: bytes.toString('base64'), sha256: digest(bytes) } })
    const process = write(`stage-${index}/process.json`, { provider: 'codex', version: '0.147.0', native: { pid: 55 + index, parentPid: 54 + index, uid: 65534, startTicks: String(100 + index), executable: '/owned/codex', executableSha256: 'd'.repeat(64), profileSha256: 'e'.repeat(64), cwd: '/owned/workspace', launch: nativeLaunch }, sdk: null })
    const accepted = write(`stage-${index}/accepted.json`, { source: 'registry-current-incarnation', soulId: rows[0]!.soulId, incarnationId: `inc-${index}`, containerId: `container-${index}`, launchNonce: `launch-${index}`, executionGeneration: index + 1, providerStoreId: rows[0]!.providerStoreId, nativeSessionId, spec: { sessionType: 'freshcodex', provider: 'codex', runtimeVariant: 'codex-app-server', providerStoreId: rows[0]!.providerStoreId, nativeSessionId, cwd: '/owned/workspace', model: 'gpt-5.6-luna', effort: 'low' } })
    const profile = write(`stage-${index}/profile.json`, { mode: 'freshcodex', process, accepted })
    return { stage, nativeFile, launch, request, namespace, store, profile, ...(crash ? { crash } : {}) }
  })
  const last = stages.at(-1)!
  const stoppedView = { soulId: rows[0]!.soulId, nativeSessionId, incarnationId: 'inc-2', containerId: 'container-2', hostBootId: 'boot-2', executionGeneration: 3,
    provider: 'codex', launchState: 'stopped', desiredState: 'stopped', cleanupState: 'verified_empty' }
  const stopped = write('stopped/read.json', { nativeFile: last.nativeFile, store: last.store, stopResult: { outcome: 'verified_empty', view: stoppedView }, stoppedView,
    writer: { provider: 'codex', soulId: rows[0]!.soulId, incarnationId: stoppedView.incarnationId, providerStoreId: rows[0]!.providerStoreId, nativeSessionId, activeClaimCount: 0, globalConflictingClaimCount: 0 },
    stopCompletedAt: 1_780_000_024_000, stoppedObservedAt: 1_780_000_024_100, writerObservedAt: 1_780_000_024_200,
    readStartedAt: 1_780_000_024_300, readCompletedAt: 1_780_000_024_400, completedTurnCount: 3 })
  write('native-recovery-originals.json', { schemaVersion: 1, candidateSha, runId: receiptRunId, runtimeImage, selected: ['freshcodex'], conversations: [{ mode: 'freshcodex', provider: 'codex', soulId: rows[0]!.soulId, providerStoreId: rows[0]!.providerStoreId, nativeSessionId, nonce, stages, stopped }] })
  rows[0]!.executionOriginal = browserExecutionFixture(rows[0]!, stages, evidenceDir, write, 'browser')
  const input = { repoRoot, evidenceDir, candidateSha, receiptRunId, runtimeImage, selectedModes: ['freshcodex'] as const, rows }
  return { input: { ...input, selectedModes: [...input.selectedModes] }, write, stages }
}

function claudeFixture(generations?: readonly number[], mode = 'freshclaude') {
  const built = fixture(), { input, write, stages } = built
  const original = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, 'native-recovery-originals.json'), 'utf8'))
  const conversation = original.conversations[0], transcript: unknown[] = []
  for (const [index, stage] of stages.entries()) {
    const request = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.request.path), 'utf8'))
    const prompt = request.request.params.text
    if (mode === 'claude') {
      const requests = [
        { ...request, requestId: `paste-${index}`, request: { method: 'terminal_input', params: { soulId: conversation.soulId, data: `\x1b[200~${prompt}\x1b[201~` } }, reply: { data: {} } },
        { ...request, request: { method: 'terminal_input', params: { soulId: conversation.soulId, data: '\r' } }, reply: { data: {} } },
      ]
      stage.request = write(stage.request.path, { requests })
    }
    const launch = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.launch.path), 'utf8')), view = launch.response.data.view
    const namespace = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.namespace.path), 'utf8'))
    view.executionGeneration = generations?.[index] ?? view.executionGeneration
    view.nativeIdentityObservation.source = mode === 'claude' ? 'claude_native_event' : 'fresh_provider_handshake'
    if (mode === 'claude') {
      launch.request = { params: { providerStoreId: view.providerStoreId } }
      delete view.providerStoreId
    }
    namespace.nativeLaunch.executionGeneration = view.executionGeneration
    stage.launch = write(stage.launch.path, launch); stage.namespace = write(stage.namespace.path, namespace)
    const base = 1_780_000_000_000 + index * 10_000
    transcript.push({ type: 'user', sessionId: conversation.nativeSessionId, uuid: `user-${index}`, message: { role: 'user', content: prompt } },
      { type: 'attachment', sessionId: conversation.nativeSessionId, uuid: `attachment-${index}`, parentUuid: `user-${index}` },
      { type: 'assistant', sessionId: conversation.nativeSessionId, uuid: `thinking-${index}`, parentUuid: `attachment-${index}`, timestamp: new Date(base + 2_500).toISOString(),
        message: { id: `turn-${index}`, role: 'assistant', model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private', signature: 'signed' }] } },
      { type: 'assistant', sessionId: conversation.nativeSessionId, uuid: `assistant-${index}`, parentUuid: `thinking-${index}`, timestamp: new Date(base + 3_000).toISOString(),
        message: { id: `turn-${index}`, role: 'assistant', model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text: index ? conversation.nonce : 'stored' }] } })
    stage.nativeFile = write(`claude-stage-${index}/${conversation.nativeSessionId}.jsonl`, transcript.map(row => JSON.stringify(row)).join('\n') + '\n')
    const store = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.store.path), 'utf8')), bytes = fs.readFileSync(path.join(input.evidenceDir, stage.nativeFile.path))
    store.snapshot.bytesBase64 = bytes.toString('base64'); store.snapshot.sha256 = digest(bytes); stage.store = write(stage.store.path, store)
  }
  original.selected = [mode]; conversation.mode = mode; conversation.provider = 'claude'; conversation.stages = stages
  write('native-recovery-originals.json', original)
  const derive = (requiredStages?: readonly ('initial' | 'after_session_host_crash' | 'after_provider_process_crash')[]) => deriveNativeRecoveryOriginals({ evidenceDir: input.evidenceDir, candidateSha, runId: receiptRunId, runtimeImage, selected: [mode], requiredStages })
  return { ...built, original, conversation, derive }
}

function opencodeFixture() {
  const built = fixture(), { input, write, stages } = built
  const original = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, 'native-recovery-originals.json'), 'utf8'))
  const conversation = original.conversations[0]
  const nativeRows: { id: string; at: number; data: Record<string, unknown>; text: string }[] = []
  const refreshStage = (index: number) => {
    const stage = stages[index]!, bytes = fs.readFileSync(path.join(input.evidenceDir, stage.nativeFile.path))
    stage.nativeFile = { path: stage.nativeFile.path, sha256: digest(bytes) }
    const store = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.store.path), 'utf8'))
    Object.assign(store.snapshot, { path: '/owned/opencode.db', bytesBase64: bytes.toString('base64'), sha256: digest(bytes) })
    stage.store = write(stage.store.path, store)
  }
  for (const [index, stage] of stages.entries()) {
    const request = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.request.path), 'utf8'))
    const base = 1_780_000_000_000 + index * 10_000
    nativeRows.push({ id: `user-${index}`, at: base + 2_000, data: { role: 'user' }, text: request.request.params.text },
      { id: `assistant-${index}`, at: base + 3_000, data: { role: 'assistant', parentID: `user-${index}`, providerID: 'opencode', modelID: 'big-pickle', time: { completed: base + 3_000 } }, text: index ? conversation.nonce : 'stored' })
    const filename = path.join(input.evidenceDir, `opencode-stage-${index}/opencode.db`)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    const db = new DatabaseSync(filename)
    try {
      db.exec('CREATE TABLE session(id TEXT PRIMARY KEY); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);')
      db.prepare('INSERT INTO session VALUES (?)').run(conversation.nativeSessionId)
      for (const row of nativeRows) {
        db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(row.id, conversation.nativeSessionId, row.at, JSON.stringify(row.data))
        db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(`part-${row.id}`, conversation.nativeSessionId, row.id, row.at, JSON.stringify({ type: 'text', text: row.text }))
      }
    } finally { db.close() }
    stage.nativeFile = { path: path.relative(input.evidenceDir, filename), sha256: digest(fs.readFileSync(filename)) }
    if (index) Object.assign(stage, { boundaryFile: stages[index - 1]!.nativeFile })
    refreshStage(index)
    request.reply = { data: {} }; stage.request = write(stage.request.path, request)
    const namespace = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.namespace.path), 'utf8'))
    namespace.httpsStatus = null
    namespace.freeModelAccess = { source: 'native-config-providers', providerId: 'opencode', modelId: 'big-pickle', endpoint: 'https://unit-free.invalid/v1', ca: 'system-default', peerCertificateSha256: 'a'.repeat(64) }
    stage.namespace = write(stage.namespace.path, namespace)
  }
  original.selected = ['freshopencode']; conversation.mode = 'freshopencode'; conversation.provider = 'opencode'; conversation.stages = stages
  write('native-recovery-originals.json', original)
  const derive = () => deriveNativeRecoveryOriginals({ evidenceDir: input.evidenceDir, candidateSha, runId: receiptRunId, runtimeImage, selected: ['freshopencode'] })
  const replaceResponse = (index: number, response: string) => {
    const db = new DatabaseSync(path.join(input.evidenceDir, stages[index]!.nativeFile.path))
    try { db.prepare('UPDATE part SET data=? WHERE message_id=?').run(JSON.stringify({ type: 'text', text: response }), `assistant-${index}`) }
    finally { db.close() }
    refreshStage(index); write('native-recovery-originals.json', original)
  }
  const failResponse = (index: number) => {
    const db = new DatabaseSync(path.join(input.evidenceDir, stages[index]!.nativeFile.path))
    try {
      db.prepare("UPDATE message SET data=json_set(data, '$.error', json(?)) WHERE id=?")
        .run(JSON.stringify({ name: 'APIError', data: { message: 'provider turn failed' } }), `assistant-${index}`)
    } finally { db.close() }
    refreshStage(index); write('native-recovery-originals.json', original)
  }
  return { derive, replaceResponse, failResponse }
}

function amplifierFixture(observed = false, atomicSaves = false) {
  const built = fixture(), { input, write, stages } = built
  const original = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, 'native-recovery-originals.json'), 'utf8'))
  const conversation = original.conversations[0], transcript: unknown[] = [], events: unknown[] = []
  const event = (name: string, at: number, data: unknown = {}) => ({ event: name, ts: new Date(at).toISOString(), session_id: conversation.nativeSessionId, schema: { name: 'amplifier.log', ver: '1.0.0' }, data })
  events.push(event('session:config', 1_780_000_000_000, { raw: { providers: [{ id: 'lunaroute', config: { default_model: observed ? 'configured-only-model' : 'glm-5.3', reasoning_effort: 'low' } }] } }))
  for (const [index, stage] of stages.entries()) {
    const base = 1_780_000_000_000 + index * 10_000
    const request = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.request.path), 'utf8'))
    const prompt = request.request.params.text
    const response = index ? conversation.nonce : 'stored'
    transcript.push({ role: 'user', content: prompt, metadata: { timestamp: new Date(base + 2_000).toISOString() } }, { role: 'assistant', content: response, metadata: { timestamp: new Date(base + 2_800).toISOString() } })
    if (observed) events.push(event('prompt:submit', base + 2_000, { prompt, parent_id: null }),
      event('llm:response', base + 2_500, { model: 'glm-5.3', provider: 'vllm', parent_id: null }),
      event('prompt:complete', base + 2_800, { length: response.length, response_preview: response, parent_id: null }),
      event('prompt:complete', base + 2_900, { prompt, response, parent_id: null }))
    else events.push(event('prompt:complete', base + 2_800))
    events.push(event('cleanup:store_end', base + 3_000))
    const prefix = `amplifier-stage-${index}/sessions/${conversation.nativeSessionId}`
    stage.nativeFile = write(`${prefix}/transcript.jsonl`, transcript.map(row => JSON.stringify(row)).join('\n') + '\n')
    Object.assign(stage, { nativeEvents: write(`${prefix}/events.jsonl`, events.map(row => JSON.stringify(row)).join('\n') + '\n') })
    request.request = { method: 'terminal_input', params: { soulId: conversation.soulId, data: prompt + '\r' } }; request.reply = { data: {} }
    stage.request = write(stage.request.path, request)
    const store = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.store.path), 'utf8')), bytes = fs.readFileSync(path.join(input.evidenceDir, stage.nativeFile.path))
    const eventBytes = fs.readFileSync(path.join(input.evidenceDir, prefix, 'events.jsonl'))
    if (atomicSaves) {
      // The pinned SessionStore writes the complete transcript through
      // write_with_backup: a same-directory temporary file replaces the target.
      const target = path.join(input.repoRoot, 'owned-amplifier', 'sessions', conversation.nativeSessionId, 'transcript.jsonl')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      if (fs.existsSync(target)) fs.copyFileSync(target, target + '.backup')
      const temporary = path.join(path.dirname(target), `.transcript-${index}.tmp`)
      fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, target)
      const descriptor = fs.openSync(target, 'r')
      try {
        const before = fs.fstatSync(descriptor, { bigint: true }), captured = fs.readFileSync(descriptor)
        const after = fs.fstatSync(descriptor, { bigint: true })
        const identity = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)
        expect(identity(after)).toEqual(identity(before))
        expect(identity(fs.statSync(target, { bigint: true }))).toEqual(identity(after))
        expect(captured.equals(bytes)).toBe(true)
        store.snapshot.path = target; store.snapshot.identity = identity(after)
      } finally { fs.closeSync(descriptor) }
    }
    store.snapshot.bytesBase64 = bytes.toString('base64'); store.snapshot.sha256 = digest(bytes)
    store.eventsSnapshot = { bytesBase64: eventBytes.toString('base64'), sha256: digest(eventBytes) }
    stage.store = write(stage.store.path, store)
  }
  original.selected = ['amplifier']; conversation.mode = 'amplifier'; conversation.provider = 'amplifier'; conversation.stages = stages
  write('native-recovery-originals.json', original)
  const derive = (requiredStages?: readonly ('initial' | 'after_session_host_crash' | 'after_provider_process_crash')[]) => deriveNativeRecoveryOriginals({ evidenceDir: input.evidenceDir, candidateSha, runId: receiptRunId, runtimeImage, selected: ['amplifier'], requiredStages })
  return { ...built, original, conversation, derive }
}

describe('qualification from private native originals', () => {
  it('rejects a failed native OpenCode recovery turn even when its partial answer recalls the marker', () => {
    const { derive, failResponse } = opencodeFixture()
    expect(derive()).toHaveLength(1)
    failResponse(2)
    expect(derive).toThrow(/native completion failed/)
  })

  it.each([2, 3])('derives %i Amplifier atomic-save recovery stages with complete prior history', count => {
    const { input, stages, original, conversation, write, derive } = amplifierFixture(true, true)
    const snapshots = stages.map(stage => JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.store.path), 'utf8')).snapshot)
    expect(new Set(snapshots.map(snapshot => snapshot.identity[0])).size).toBe(1)
    for (let index = 1; index < snapshots.length; index++) expect(snapshots[index].identity[1]).not.toBe(snapshots[index - 1].identity[1])
    if (count === 2) {
      const replacement = stages[1]!
      replacement.stage = 'after_provider_process_crash'
      const crash = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, replacement.crash!.path), 'utf8'))
      crash.kind = 'provider_process_exit'; replacement.crash = write(replacement.crash!.path, crash)
      conversation.stages = [stages[0], replacement]; write('native-recovery-originals.json', original)
    }
    const requiredStages: NativeRecoveryStage[] = count === 2 ? ['initial', 'after_provider_process_crash'] : ['initial', 'after_session_host_crash', 'after_provider_process_crash']
    expect(derive(requiredStages)[0]!.stages.map(stage => [stage.stage, stage.recalledNonce, stage.noTools, stage.profile.observedModel])).toEqual(
      requiredStages.map((stage: string, index: number) => [stage, index !== 0, true, 'glm-5.3']),
    )
  })

  it.each([false, true])('requires the full persisted Amplifier prefix, including records outside completed turns (atomic saves: %s)', atomicSaves => {
    const { input, stages, original, write, derive } = amplifierFixture(true, atomicSaves)
    const initial = stages[0]!, bytes = Buffer.concat([fs.readFileSync(path.join(input.evidenceDir, initial.nativeFile.path)), Buffer.from(JSON.stringify({ role: 'system', content: 'persisted context' }) + '\n')])
    initial.nativeFile = write(initial.nativeFile.path, bytes.toString('utf8'))
    const store = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, initial.store.path), 'utf8'))
    Object.assign(store.snapshot, { bytesBase64: bytes.toString('base64'), sha256: digest(bytes) })
    initial.store = write(initial.store.path, store); write('native-recovery-originals.json', original)
    expect(derive).toThrow(/prefix/)
  })

  it.each(['device', 'volume', 'path', 'truncated', 'copy', 'lost-prefix', 'missing-completion', 'missing-nonce', 'tool', 'wrong-root', 'wrong-store', 'wrong-soul', 'profile', 'executable', 'workspace', 'stale-launch', 'stale-revision', 'reused-incarnation', 'nonce-input', 'crash-order', 'completion-event'] as const)(
    'refuses invalid Amplifier atomic-save recovery authority (%s)', fault => {
      const { input, stages, original, write, derive } = amplifierFixture(true, true)
      expect(derive()).toHaveLength(1)
      const stage = stages[1]!
      const store = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.store.path), 'utf8'))
      const namespace = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.namespace.path), 'utf8'))
      const launch = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.launch.path), 'utf8')), view = launch.response.data.view
      if (fault === 'device') store.snapshot.identity[0] = 'other-device'
      if (fault === 'volume') store.providerVolumeName = 'other-volume'
      if (fault === 'path') store.snapshot.path += '.other'
      if (fault === 'truncated') store.snapshot.completeEof = false
      if (fault === 'copy') store.snapshot.bytesBase64 = Buffer.from('unrelated\n').toString('base64')
      if (fault === 'wrong-root') view.nativeSessionId = view.nativeIdentityObservation.nativeSessionId = namespace.nativeRoot = 'other-root'
      if (fault === 'wrong-store') view.providerStoreId = 'other-store'
      if (fault === 'wrong-soul') view.soulId = 'other-soul'
      if (fault === 'profile') namespace.profileSha256 = 'f'.repeat(64)
      if (fault === 'executable') namespace.executableSha256 = 'f'.repeat(64)
      if (fault === 'workspace') namespace.nativeCwd = '/other/workspace'
      if (fault === 'stale-launch') namespace.nativeLaunch.launchNonce = 'launch-0'
      if (fault === 'stale-revision') view.nativeIdentityObservation.evidenceRevision = namespace.nativeLaunch.evidenceRevision = 0
      if (fault === 'reused-incarnation') view.incarnationId = view.nativeIdentityObservation.incarnationId = namespace.nativeLaunch.incarnationId = 'inc-0'
      if (fault === 'nonce-input') {
        const request = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.request.path), 'utf8'))
        request.request.params.data = original.conversations[0].nonce + '\r'; stage.request = write(stage.request.path, request)
      }
      if (fault === 'crash-order') {
        const crash = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.crash!.path), 'utf8'))
        crash.requestedAt -= 6_000; stage.crash = write(stage.crash!.path, crash)
      }
      if (['lost-prefix', 'missing-completion', 'missing-nonce', 'tool'].includes(fault)) {
        const rows = fs.readFileSync(path.join(input.evidenceDir, stage.nativeFile.path), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        if (fault === 'lost-prefix') rows.splice(0, 2)
        if (fault === 'missing-completion') rows.pop()
        if (fault === 'missing-nonce') rows.at(-1).content = 'not recalled'
        if (fault === 'tool') rows.at(-1).tool_calls = [{ function: { name: 'read_file' } }]
        const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n')
        stage.nativeFile = write(stage.nativeFile.path, bytes.toString('utf8'))
        Object.assign(store.snapshot, { bytesBase64: bytes.toString('base64'), sha256: digest(bytes) })
      }
      if (fault === 'completion-event') {
        const events = fs.readFileSync(path.join(input.evidenceDir, (stage as any).nativeEvents.path), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        events.pop()
        const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n')
        Object.assign(stage, { nativeEvents: write((stage as any).nativeEvents.path, bytes.toString('utf8')) })
        Object.assign(store.eventsSnapshot, { bytesBase64: bytes.toString('base64'), sha256: digest(bytes) })
      }
      stage.store = write(stage.store.path, store); stage.namespace = write(stage.namespace.path, namespace); stage.launch = write(stage.launch.path, launch)
      write('native-recovery-originals.json', original)
      expect(derive).toThrow(/native|Amplifier/)
    },
  )

  it('derives terminal Claude seed and post-provider-crash recall with incarnation-local generation 1', () => {
    const { input, stages, original, conversation, write, derive } = claudeFixture([1, 1, 1], 'claude')
    const replacement = stages[1]!
    replacement.stage = 'after_provider_process_crash'
    const crash = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, replacement.crash!.path), 'utf8'))
    crash.kind = 'provider_process_exit'; replacement.crash = write(replacement.crash!.path, crash)
    conversation.stages = [stages[0], replacement]; write('native-recovery-originals.json', original)
    const observed = derive(['initial', 'after_provider_process_crash'])[0]!
    expect(observed.stages.map(stage => [stage.stage, stage.incarnationId, stage.executionGeneration, stage.recalledNonce, stage.noTools])).toEqual([
      ['initial', 'inc-0', 1, false, true], ['after_provider_process_crash', 'inc-1', 1, true, true],
    ])
  })

  it.each(['claude', 'freshclaude', 'kilroy'])('derives all three %s stages when each replacement starts generation 1', mode => {
    const { derive } = claudeFixture([1, 1, 1], mode)
    expect(derive()[0]!.stages.map(stage => [stage.incarnationId, stage.executionGeneration, stage.recalledNonce])).toEqual([
      ['inc-0', 1, false], ['inc-1', 1, true], ['inc-2', 1, true],
    ])
  })

  it('accepts a positive replacement generation lower than the prior incarnation counter', () => {
    const { derive } = claudeFixture([4, 1, 2])
    expect(derive()[0]!.stages.map(stage => stage.executionGeneration)).toEqual([4, 1, 2])
  })

  it('derives Amplifier recovery with a separately committed generation 1 in every incarnation', () => {
    const { input, stages, original, write, derive } = amplifierFixture(true)
    for (const stage of stages) {
      const launch = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.launch.path), 'utf8'))
      const namespace = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.namespace.path), 'utf8'))
      launch.response.data.view.executionGeneration = 1; namespace.nativeLaunch.executionGeneration = 1
      stage.launch = write(stage.launch.path, launch); stage.namespace = write(stage.namespace.path, namespace)
    }
    write('native-recovery-originals.json', original)
    expect(derive()[0]!.stages.map(stage => [stage.executionGeneration, stage.recalledNonce])).toEqual([[1, false], [1, true], [1, true]])
  })

  it.each([
    'zero-generation', 'negative-generation', 'fractional-generation', 'missing-generation', 'stale-child-generation',
    'stale-child-incarnation', 'stale-child-nonce', 'stale-child-revision', 'observed-incarnation-disagreement',
    'reused-container', 'reused-incarnation', 'reused-incarnation-increased-generation', 'reused-launch-nonce',
    'unchanged-revision', 'backwards-revision', 'wrong-soul', 'wrong-store', 'wrong-root',
    'changed-profile', 'changed-executable', 'changed-workspace', 'crash-before-completion', 'exit-before-request', 'capture-before-exit',
  ] as const)('refuses invalid incarnation-local execution authority (%s)', fault => {
    const { input, stages, original, write, derive } = claudeFixture([1, 1, 1], 'claude')
    expect(derive()).toHaveLength(1)
    const stage = stages[1]!
    const launch = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.launch.path), 'utf8')), view = launch.response.data.view
    const namespace = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.namespace.path), 'utf8'))
    const crash = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.crash!.path), 'utf8'))
    const store = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.store.path), 'utf8'))
    if (fault === 'zero-generation') view.executionGeneration = namespace.nativeLaunch.executionGeneration = 0
    if (fault === 'negative-generation') view.executionGeneration = namespace.nativeLaunch.executionGeneration = -1
    if (fault === 'fractional-generation') view.executionGeneration = namespace.nativeLaunch.executionGeneration = 1.5
    if (fault === 'missing-generation') { delete view.executionGeneration; delete namespace.nativeLaunch.executionGeneration }
    if (fault === 'stale-child-generation') namespace.nativeLaunch.executionGeneration = 2
    if (fault === 'stale-child-incarnation') namespace.nativeLaunch.incarnationId = 'inc-0'
    if (fault === 'stale-child-nonce') namespace.nativeLaunch.launchNonce = 'launch-0'
    if (fault === 'stale-child-revision') namespace.nativeLaunch.evidenceRevision = 0
    if (fault === 'observed-incarnation-disagreement') view.nativeIdentityObservation.incarnationId = 'inc-0'
    if (fault === 'reused-container') view.containerId = namespace.ownedProbe.containerId = store.containerId = 'container-0'
    if (fault === 'reused-incarnation' || fault === 'reused-incarnation-increased-generation') {
      view.incarnationId = view.nativeIdentityObservation.incarnationId = namespace.nativeLaunch.incarnationId = 'inc-0'
      if (fault === 'reused-incarnation-increased-generation') view.executionGeneration = namespace.nativeLaunch.executionGeneration = 2
    }
    if (fault === 'reused-launch-nonce') view.nativeIdentityObservation.launchNonce = namespace.nativeLaunch.launchNonce = 'launch-0'
    if (fault === 'unchanged-revision') view.nativeIdentityObservation.evidenceRevision = namespace.nativeLaunch.evidenceRevision = 0
    if (fault === 'backwards-revision') {
      const initial = stages[0]!
      const initialLaunch = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, initial.launch.path), 'utf8'))
      const initialNamespace = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, initial.namespace.path), 'utf8'))
      initialLaunch.response.data.view.nativeIdentityObservation.evidenceRevision = initialNamespace.nativeLaunch.evidenceRevision = 2
      initial.launch = write(initial.launch.path, initialLaunch); initial.namespace = write(initial.namespace.path, initialNamespace)
    }
    if (fault === 'wrong-soul') view.soulId = 'other-soul'
    if (fault === 'wrong-store') launch.request.params.providerStoreId = 'other-store'
    if (fault === 'wrong-root') view.nativeSessionId = view.nativeIdentityObservation.nativeSessionId = namespace.nativeRoot = 'other-root'
    if (fault === 'changed-profile') namespace.profileSha256 = 'f'.repeat(64)
    if (fault === 'changed-executable') namespace.executableSha256 = 'f'.repeat(64)
    if (fault === 'changed-workspace') namespace.nativeCwd = '/other/workspace'
    if (fault === 'crash-before-completion') crash.requestedAt -= 6_000
    if (fault === 'exit-before-request') crash.exitedAt = crash.requestedAt - 1
    if (fault === 'capture-before-exit') launch.capturedAt = crash.exitedAt - 1
    stage.launch = write(stage.launch.path, launch); stage.namespace = write(stage.namespace.path, namespace)
    stage.crash = write(stage.crash!.path, crash); stage.store = write(stage.store.path, store)
    write('native-recovery-originals.json', original)
    expect(derive).toThrow(/native/)
  })

  it('derives one assembled Claude reply per request at every recovery stage from actual split rows', () => {
    const { derive } = claudeFixture()
    const stages = derive()[0]!.stages
    expect(stages.map(stage => [stage.stage, stage.recalledNonce, stage.profile.observedModel, stage.profile.effort])).toEqual([
      ['initial', false, 'claude-haiku-4-5-20251001', null], ['after_session_host_crash', true, 'claude-haiku-4-5-20251001', null], ['after_provider_process_crash', true, 'claude-haiku-4-5-20251001', null],
    ])
    expect(stages.every(stage => stage.nativeEvidence.kind === 'identified_message' && stage.nativeEvidence.turnId.startsWith('turn-'))).toBe(true)
  })

  it('accepts synthetic OpenCode nonce recall after both owned crashes', () => {
    const { derive } = opencodeFixture()
    expect(derive()[0]!.stages.map(stage => [stage.stage, stage.recalledNonce, stage.noTools])).toEqual([
      ['initial', false, true], ['after_session_host_crash', true, true], ['after_provider_process_crash', true, true],
    ])
  })

  it.each([
    { index: 1, stage: 'after_session_host_crash' },
    { index: 2, stage: 'after_provider_process_crash' },
  ] as const)('reports a fixed diagnostic for missing OpenCode recall at $stage', ({ index, stage }) => {
    const { derive, replaceResponse } = opencodeFixture()
    expect(derive()[0]!.stages[index]!.recalledNonce).toBe(true)
    replaceResponse(index, 'synthetic response without the remembered marker')
    let failure: unknown
    try { derive() } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(NativeRecoveryValidationError)
    expect(failure).toMatchObject({ diagnostic: { code: 'recovery_nonce_not_recalled', stage } })
    expect(nativeRecoveryValidationDiagnostic(failure)).toEqual({ code: 'recovery_nonce_not_recalled', stage })
  })

  it.each(['missing-nonce', 'tool', 'parent', 'duplicate-provider-id', 'changed-prior-component', 'root', 'missing-model', 'cross-run'] as const)(
    'refuses mutated assembled Claude recovery originals (%s)', fault => {
      const { input, stages, original, write, derive } = claudeFixture()
      expect(derive()).toHaveLength(1)
      const stage = stages[1]!, rows = fs.readFileSync(path.join(input.evidenceDir, stage.nativeFile.path), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      if (fault === 'missing-nonce') rows.at(-1).message.content[0].text = 'not recalled'
      if (fault === 'tool') rows.at(-1).message.content.push({ type: 'tool_use', id: 'tool', name: 'Read', input: {} })
      if (fault === 'parent') rows.at(-1).parentUuid = 'unrelated'
      if (fault === 'duplicate-provider-id') for (const row of rows.slice(4)) if (row.type === 'assistant') row.message.id = 'turn-0'
      if (fault === 'changed-prior-component') rows[2].message.content[0].thinking = 'changed prior native component'
      if (fault === 'root') rows.at(-1).sessionId = 'other-root'
      if (fault === 'missing-model') delete rows.at(-1).message.model
      stage.nativeFile = write(stage.nativeFile.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      const store = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.store.path), 'utf8')), bytes = fs.readFileSync(path.join(input.evidenceDir, stage.nativeFile.path))
      store.snapshot.bytesBase64 = bytes.toString('base64'); store.snapshot.sha256 = digest(bytes)
      if (fault === 'cross-run') store.execution.runId = 'other-run'
      stage.store = write(stage.store.path, store); write('native-recovery-originals.json', original)
      expect(derive).toThrow()
    },
  )

  it('derives Amplifier observed response model separately from configured profile and unknown optional effort', () => {
    const { derive, original, conversation, write } = amplifierFixture(true)
    expect(derive()[0]!.stages.map(stage => stage.profile)).toEqual([0, 1, 2].map(() => ({
      provider: 'vllm', model: 'glm-5.3', observedModel: 'glm-5.3', modelProvenance: 'amplifier-llm:response.model', effort: null, effortProvenance: 'unsupported-native-telemetry',
    })))
    conversation.stages[1].observedReasoningEffort = 'low'; write('native-recovery-originals.json', original)
    expect(derive).toThrow(/observed effort/i)
  })

  it.each(['missing-full', 'conflicting-preview', 'conflicting-length', 'empty-sole-data'] as const)(
    'refuses incomplete Amplifier callbacks through native recovery derivation (%s)', fault => {
      const { input, stages, original, write, derive } = amplifierFixture(true)
      expect(derive()).toHaveLength(1)
      const stage = stages[1]!, events = fs.readFileSync(path.join(input.evidenceDir, (stage as any).nativeEvents.path), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const full = events.findLastIndex(event => event.event === 'prompt:complete' && typeof event.data.response === 'string')
      events.splice(full, 1)
      const preview = events.findLast(event => event.event === 'prompt:complete')!
      if (fault === 'conflicting-preview') preview.data.response_preview = 'unrelated'
      if (fault === 'conflicting-length') preview.data.length = 100
      if (fault === 'empty-sole-data') preview.data = {}
      const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n')
      Object.assign(stage, { nativeEvents: write((stage as any).nativeEvents.path, bytes.toString('utf8')) })
      const store = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.store.path), 'utf8'))
      store.eventsSnapshot.bytesBase64 = bytes.toString('base64'); store.eventsSnapshot.sha256 = digest(bytes)
      stage.store = write(stage.store.path, store); write('native-recovery-originals.json', original)
      expect(derive).toThrow(/completion|callback|response/i)
    },
  )
  it('refuses missing originals through the actual settled owner finalizer without publishing assertions or a receipt', async () => {
    const { input } = fixture()
    // The source-only Cloud image has no Git checkout. Give the actual owner
    // an owned fixture repository instead of borrowing host source identity.
    execFileSync('git', ['init', '--quiet'], { cwd: input.repoRoot, timeout: 10_000 })
    execFileSync('git', ['-c', 'user.name=Dan Shapiro', '-c', 'user.email=3732858+danshapiro@users.noreply.github.com',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'Owned qualification finalizer fixture'], { cwd: input.repoRoot, timeout: 10_000 })
    const owner = new ManagedRuntimeOwner(() => { throw new Error('unused native original fixture web') }, input.repoRoot, 5,
      {}, {}, 'release', { enabledProviders: [], freshAgentModes: ['freshcodex'] })
    Object.assign(owner, { stopSettlement: Promise.resolve({ ok: true, errors: [] }) })
    Object.assign(owner.runtime, { evidenceDir: input.evidenceDir, candidateSha, runId: receiptRunId, imageRef: runtimeImage, browserDir: path.join(input.evidenceDir, 'browser') })
    const target = path.join(input.evidenceDir, 'published-receipt.json')
    vi.stubEnv('FRESHELL_RUNTIME_PHASE3_FRESH_AGENT_RECEIPT', target)
    vi.stubEnv('FRESHELL_RUNTIME_PHASE5_FRESH_AGENT_RECEIPT', target)
    fs.unlinkSync(path.join(input.evidenceDir, 'native-recovery-originals.json'))
    await expect(owner.publishFreshAgentQualification(input.rows)).rejects.toThrow(/native originals artifact is missing/)
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.existsSync(path.join(input.evidenceDir, 'fresh-agent-qualification-assertions.json'))).toBe(false)
  })
  it('derives exactly three distinct native recovery stages from intact original material', () => {
    const { input } = fixture()
    const observed = deriveNativeRecoveryOriginals({ evidenceDir: input.evidenceDir, candidateSha, runId: receiptRunId, runtimeImage, selected: ['freshcodex'] })
    expect(observed[0]!.stages.map(stage => [stage.stage, stage.nativeEvidence.kind, stage.noTools, stage.recalledNonce])).toEqual([
      ['initial', 'identified_message', true, false], ['after_session_host_crash', 'identified_message', true, true], ['after_provider_process_crash', 'identified_message', true, true],
    ])
    expect(buildFreshAgentQualificationReceipt(input).rows).toEqual(input.rows)
  })
  it('keeps the observed launch revision distinct from the registry revision and accepts truthful Codex null-root probes', () => {
    const { input, stages, write } = fixture()
    for (const stage of stages) {
      const launch = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.launch.path), 'utf8')), view = launch.response.data.view
      view.evidenceRevision = 999; stage.launch = write(stage.launch.path, launch)
      const namespace = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.namespace.path), 'utf8'))
      namespace.nativeRoot = null
      namespace.nativeLaunch = { incarnationId: view.incarnationId, launchNonce: view.nativeIdentityObservation.launchNonce, evidenceRevision: view.nativeIdentityObservation.evidenceRevision, executionGeneration: view.executionGeneration }
      stage.namespace = write(stage.namespace.path, namespace)
    }
    const original = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, 'native-recovery-originals.json'), 'utf8')); original.conversations[0].stages = stages
    write('native-recovery-originals.json', original)
    const receipt = buildFreshAgentQualificationReceipt(input)
    expect(validateFreshAgentQualificationReceipt({ repoRoot: input.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt }).rows).toEqual(input.rows)
  })
  it('preserves Amplifier append-only evidence and leaves configured model/effort unobserved', () => {
    const { original, conversation, write, derive } = amplifierFixture()
    expect(derive()[0]!.stages.map(stage => stage.nativeEvidence.kind)).toEqual(['append_only_record', 'append_only_record', 'append_only_record'])
    expect(derive()[0]!.stages.every(stage => stage.profile.observedModel === null && stage.profile.effort === null)).toBe(true)
    conversation.stages[1].observedReasoningEffort = 'low'; write('native-recovery-originals.json', original)
    expect(derive).toThrow(/observed effort/i)
  })
  it.each(['nonce-contaminated-recall', 'stale-namespace'] as const)('refuses reviewed %s through both builder and validator', fault => {
    const { input, stages, write } = fixture(), receipt = buildFreshAgentQualificationReceipt(input)
    const original = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, 'native-recovery-originals.json'), 'utf8'))
    if (fault === 'stale-namespace') stages[1]!.namespace = stages[0]!.namespace
    else {
      const request = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stages[1]!.request.path), 'utf8'))
      request.request.params.text += ` Echo ${original.conversations[0].nonce}.`
      stages[1]!.request = write(stages[1]!.request.path, request)
      for (const stage of stages.slice(1)) {
        const rows = fs.readFileSync(path.join(input.evidenceDir, stage.nativeFile.path), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        const user = rows.findIndex(row => row.type === 'turn_context' && row.payload.turn_id === 'turn-1') + 1
        rows[user].payload.message = request.request.params.text
        stage.nativeFile = write(stage.nativeFile.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
        const store = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.store.path), 'utf8')), bytes = fs.readFileSync(path.join(input.evidenceDir, stage.nativeFile.path))
        store.snapshot.bytesBase64 = bytes.toString('base64'); store.snapshot.sha256 = digest(bytes); stage.store = write(stage.store.path, store)
      }
    }
    original.conversations[0].stages = stages
    const reference = write('native-recovery-originals.json', original)
    receipt.artifacts.nativeOriginals = { path: `${receipt.evidenceRun}/${reference.path}`, sha256: reference.sha256 }
    const refused = [() => buildFreshAgentQualificationReceipt(input), () => validateFreshAgentQualificationReceipt({ repoRoot: input.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt })].map(operation => {
      try { operation(); return false } catch { return true }
    })
    expect(refused).toEqual([true, true])
  })
  it.each(['removed-tool-event', 'changed-completion-event', 'assistant-before-input', 'interleaved-append'] as const)('refuses reviewed Amplifier %s with valid recomputed copy hashes', fault => {
    const { input, stages, write, original, conversation, derive } = amplifierFixture()
    const stage = conversation.stages[1]
    stage.stage = 'after_provider_process_crash'; conversation.stages = [stages[0], stage]
    const crash = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.crash.path), 'utf8')); crash.kind = 'provider_process_exit'; stage.crash = write(stage.crash.path, crash)
    write('native-recovery-originals.json', original)
    expect(derive(['initial', 'after_provider_process_crash'])).toHaveLength(1)
    if (fault === 'removed-tool-event' || fault === 'changed-completion-event') {
      const events = fs.readFileSync(path.join(input.evidenceDir, stage.nativeEvents.path), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      if (fault === 'removed-tool-event') {
        const tool = { ...events.at(-1), event: 'tool:pre', data: { tool_name: 'read_file' } }
        const actual = [...events.slice(0, -1), tool, events.at(-1)].map(row => JSON.stringify(row)).join('\n') + '\n'
        const store = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.store.path), 'utf8'))
        store.eventsSnapshot = { bytesBase64: Buffer.from(actual).toString('base64'), sha256: digest(actual) }; stage.store = write(stage.store.path, store)
      } else events.at(-1).ts = new Date(Date.parse(events.at(-1).ts) + 100).toISOString()
      stage.nativeEvents = write(stage.nativeEvents.path, events.map(row => JSON.stringify(row)).join('\n') + '\n')
    } else {
      const rows = fs.readFileSync(path.join(input.evidenceDir, stage.nativeFile.path), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      if (fault === 'assistant-before-input') [rows[2], rows[3]] = [rows[3], rows[2]]
      else rows.splice(3, 0, { role: 'system', content: 'interleaved context' })
      stage.nativeFile = write(stage.nativeFile.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      const store = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.store.path), 'utf8')), bytes = fs.readFileSync(path.join(input.evidenceDir, stage.nativeFile.path))
      store.snapshot.bytesBase64 = bytes.toString('base64'); store.snapshot.sha256 = digest(bytes); stage.store = write(stage.store.path, store)
    }
    write('native-recovery-originals.json', original)
    expect(() => derive(['initial', 'after_provider_process_crash'])).toThrow()
  })
  it.each(['missing-input', 'duplicate-input', 'duplicate-completion', 'wrong-input', 'missing-nonce', 'tool', 'wrong-native-root', 'wrong-native-turn', 'unbound-native-file', 'wrong-store', 'wrong-launch', 'wrong-volume', 'changed-file', 'recall-before-crash', 'changed-candidate', 'changed-image', 'cross-run', 'cross-run-source', 'reordered-stages', 'missing-original'])(
    'refuses %s in builder and validator with unchanged summaries and recomputed valid digests', fault => {
      const { input, write, stages } = fixture(), receipt = buildFreshAgentQualificationReceipt(input)
      const stage = stages[1]!
      if (['missing-input', 'duplicate-input', 'duplicate-completion', 'wrong-input', 'missing-nonce', 'tool', 'wrong-native-root', 'wrong-native-turn', 'unbound-native-file'].includes(fault)) {
        let rows = fs.readFileSync(path.join(input.evidenceDir, stage.nativeFile.path), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        const user = rows.findIndex(row => row.payload?.type === 'user_message' && row.payload.message.startsWith('Recall'))
        const completion = rows.findIndex(row => row.payload?.type === 'task_complete' && row.payload.turn_id === 'turn-1')
        if (fault === 'missing-input') rows.splice(user, 1)
        if (fault === 'duplicate-input') rows.splice(user, 0, structuredClone(rows[user]))
        if (fault === 'duplicate-completion') rows.push(structuredClone(rows[completion]))
        if (fault === 'wrong-input') rows[user].payload.message = 'different native input'
        if (fault === 'missing-nonce') {
          rows[completion].payload.last_agent_message = 'not recalled'
          rows.find(row => row.payload?.id === 'assistant-1').payload.content[0].text = 'not recalled'
        }
        if (fault === 'tool') rows.splice(completion, 0, { type: 'response_item', payload: { type: 'function_call', name: 'read_file' } })
        if (fault === 'wrong-native-root') rows[0].payload.id = 'other-native-root'
        if (fault === 'wrong-native-turn') rows[completion].payload.turn_id = 'turn-0'
        if (fault === 'unbound-native-file') { rows.splice(completion, 1); stage.nativeFile.path = 'stage-1/unused-original.jsonl' }
        stage.nativeFile = write(stage.nativeFile.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
        const source = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.store.path), 'utf8')), bytes = fs.readFileSync(path.join(input.evidenceDir, stage.nativeFile.path))
        source.snapshot.bytesBase64 = bytes.toString('base64'); source.snapshot.sha256 = digest(bytes)
        stage.store = write(stage.store.path, source)
      } else if (fault === 'wrong-store' || fault === 'wrong-launch') {
        const launch = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.launch.path), 'utf8'))
        if (fault === 'wrong-store') launch.response.data.view.providerStoreId = 'other-store'
        else launch.response.data.view.nativeIdentityObservation.incarnationId = 'stale-incarnation'
        stage.launch = write(stage.launch.path, launch)
      } else if (fault === 'wrong-volume' || fault === 'changed-file' || fault === 'cross-run-source') {
        const store = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.store.path), 'utf8'))
        if (fault === 'wrong-volume') store.providerVolumeName = 'copied-volume'
        else if (fault === 'changed-file') store.snapshot.identity[1] = 'replaced-inode'
        else store.execution = { candidateSha, runId: 'another-run', runtimeImage }
        stage.store = write(stage.store.path, store)
      } else if (fault === 'recall-before-crash') {
        const crash = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.crash!.path), 'utf8')); crash.requestedAt += 20_000
        stage.crash = write(stage.crash!.path, crash)
      } else if (fault === 'reordered-stages') [stages[1], stages[2]] = [stages[2]!, stages[1]!]
      else if (fault === 'missing-original') fs.unlinkSync(path.join(input.evidenceDir, stage.nativeFile.path))
      const original = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, 'native-recovery-originals.json'), 'utf8'))
      original.conversations[0].stages = stages
      if (fault === 'changed-candidate') original.candidateSha = 'c'.repeat(40)
      if (fault === 'changed-image') original.runtimeImage = `sha256:${'c'.repeat(64)}`
      if (fault === 'cross-run') original.runId = 'another-run'
      const reference = write('native-recovery-originals.json', original)
      receipt.artifacts.nativeOriginals = { path: `${receipt.evidenceRun}/${reference.path}`, sha256: reference.sha256 }
      expect(() => buildFreshAgentQualificationReceipt(input)).toThrow()
      expect(() => validateFreshAgentQualificationReceipt({ repoRoot: input.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt })).toThrow()
    },
  )
  it('keeps unsupported native effort unknown and refuses a claimed observed low without telemetry', () => {
    const { input, write, stages } = fixture()
    for (const stage of stages) {
      const rows = fs.readFileSync(path.join(input.evidenceDir, stage.nativeFile.path), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      for (const row of rows) if (row.type === 'turn_context') delete row.payload.effort
      stage.nativeFile = write(stage.nativeFile.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      const store = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stage.store.path), 'utf8')), bytes = fs.readFileSync(path.join(input.evidenceDir, stage.nativeFile.path))
      store.snapshot.bytesBase64 = bytes.toString('base64'); store.snapshot.sha256 = digest(bytes); stage.store = write(stage.store.path, store)
    }
    const original = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, 'native-recovery-originals.json'), 'utf8')); original.conversations[0].stages = stages
    write('native-recovery-originals.json', original)
    expect(deriveNativeRecoveryOriginals({ evidenceDir: input.evidenceDir, candidateSha, runId: receiptRunId, runtimeImage, selected: ['freshcodex'] })[0]!.stages.every(stage => stage.profile.effort === null)).toBe(true)
    const last = stages.at(-1)!
    const stoppedRead = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, original.conversations[0].stopped.path), 'utf8'))
    original.conversations[0].stopped = write('stopped/read.json', { ...stoppedRead, nativeFile: last.nativeFile, store: last.store })
    write('native-recovery-originals.json', original)
    const receipt = buildFreshAgentQualificationReceipt(input)
    original.conversations[0].stages[1].observedReasoningEffort = 'low'
    const reference = write('native-recovery-originals.json', original)
    receipt.artifacts.nativeOriginals = { path: `${receipt.evidenceRun}/${reference.path}`, sha256: reference.sha256 }
    expect(() => buildFreshAgentQualificationReceipt(input)).toThrow(/observed effort/i)
    expect(() => validateFreshAgentQualificationReceipt({ repoRoot: input.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt })).toThrow(/observed effort/i)
  })
  it('refuses a missing post-host native completion despite intact three-turn claims and valid digests', () => {
    const { input } = fixture(true)
    expect(() => buildFreshAgentQualificationReceipt(input)).toThrow(/native|completion/i)
  })
  it('reopens the native originals during validation instead of trusting receipt claims', () => {
    const { input, write, stages } = fixture()
    const receipt = buildFreshAgentQualificationReceipt(input)
    const file = stages[1]!.nativeFile.path
    const rows = fs.readFileSync(path.join(input.evidenceDir, file), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    stages[1]!.nativeFile = write(file, rows.filter(row => row.payload?.type !== 'task_complete').map(row => JSON.stringify(row)).join('\n') + '\n')
    const store = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, stages[1]!.store.path), 'utf8'))
    const bytes = fs.readFileSync(path.join(input.evidenceDir, file)); store.snapshot.bytesBase64 = bytes.toString('base64'); store.snapshot.sha256 = digest(bytes)
    stages[1]!.store = write(stages[1]!.store.path, store)
    const original = JSON.parse(fs.readFileSync(path.join(input.evidenceDir, 'native-recovery-originals.json'), 'utf8'))
    original.conversations[0].stages = stages
    const reference = write('native-recovery-originals.json', original)
    ;(receipt.artifacts as unknown as Record<string, unknown>).nativeOriginals = { path: `${receipt.evidenceRun}/${reference.path}`, sha256: reference.sha256 }
    expect(() => validateFreshAgentQualificationReceipt({ repoRoot: input.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt })).toThrow(/native|completion/i)
  })
})
