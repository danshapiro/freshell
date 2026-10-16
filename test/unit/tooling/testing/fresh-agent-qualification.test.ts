// @vitest-environment node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedRuntimeOwner } from '../../../../scripts/testing/runtime-sandbox.js'

import {
  buildFreshAgentQualificationReceipt,
  validateFreshAgentQualificationReceipt,
  type FreshAgentQualificationRow,
} from '../../../../scripts/testing/fresh-agent-qualification-receipt.js'
import {
  FRESH_AGENT_QUALIFICATION_MODES_ENV,
  parseFreshAgentQualificationModes,
} from '../../../../scripts/testing/fresh-agent-qualification-selection.js'
import {
  freshAgentReleaseScopeViolations,
} from '../../../../scripts/testing/provider-certification.js'
import { releasedFreshAgentReceiptRows } from '../../../../scripts/testing/fresh-agent-release-gate.js'
import { selectedFreshAgentModeFromArgs } from '../../../../scripts/testing/runtime-fresh-agent-qualification.js'
import { FRESH_AGENT_INGRESS_INVENTORY } from '../../../../scripts/testing/fresh-agent-ingress-inventory.js'

const candidateSha = 'a'.repeat(40)
const runtimeImage = `sha256:${'b'.repeat(64)}`
const receiptRunId = 'fresh-agent-live-001'
const tempRoots: string[] = []

describe('observed fresh browser execution', () => {
  it.each(['api-error', 'api-error-with-text', 'empty', 'whitespace'])(
    'rejects a finalized OpenCode browser answer with %s through the native reader and receipt', fault => {
      const built = fixture([row('freshopencode')], 'production', 'low', true)
      const original = readBrowserExecution(built)
      const filename = path.join(built.evidenceDir, original.ui.after.path)
      const db = new DatabaseSync(filename)
      const assistant = db.prepare('SELECT id, data FROM message WHERE json_extract(data, \'$.role\') = \'assistant\'').get() as { id: string; data: string }
      const data = JSON.parse(assistant.data)
      if (fault.startsWith('api-error')) data.error = { name: 'APIError', data: { message: 'PRIVATE_PROVIDER_ERROR' } }
      db.prepare('UPDATE message SET data=? WHERE id=?').run(JSON.stringify(data), assistant.id)
      db.prepare('UPDATE part SET data=? WHERE message_id=?').run(JSON.stringify({ type: 'text',
        text: fault === 'api-error-with-text' ? 'partial answer' : fault === 'whitespace' ? '  \n' : '' }), assistant.id)
      db.close()
      original.ui.after.sha256 = createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
      rewriteBrowserExecution(built, original)
      expect(() => validateFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt: built.receipt }))
        .toThrow(/browser native no-tool completion/)
      expect(() => buildFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, evidenceDir: built.evidenceDir, candidateSha,
        receiptRunId, runtimeImage, selectedModes: ['freshopencode'], rows: built.receipt.rows })).toThrow(/browser native no-tool completion/)
    },
  )

  it('reopens the materialized OpenCode native send acknowledgment from retained originals', () => {
    const built = fixture([row('freshopencode')], 'production', 'low', true)
    const original = readBrowserExecution(built)
    original.ui.reply.sessionId = original.ui.view.nativeSessionId
    original.ui.reply.provider = 'opencode'
    original.ui.reply.sessionType = 'freshopencode'
    rewriteBrowserExecution(built, original)
    expect(() => validateFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt: built.receipt })).not.toThrow()
    expect(() => buildFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, evidenceDir: built.evidenceDir, candidateSha,
      receiptRunId, runtimeImage, selectedModes: ['freshopencode'], rows: built.receipt.rows })).not.toThrow()
  })

  it.each(['foreign-session', 'provider', 'mode', 'request', 'native-observation'])('rejects a materialized OpenCode native acknowledgment with %s from retained originals', fault => {
    const built = fixture([row('freshopencode')], 'production', 'low', true)
    const original = readBrowserExecution(built)
    original.ui.reply.sessionId = original.ui.view.nativeSessionId
    original.ui.reply.provider = 'opencode'
    original.ui.reply.sessionType = 'freshopencode'
    if (fault === 'foreign-session') original.ui.reply.sessionId = 'third-unrelated-native'
    if (fault === 'provider') original.ui.reply.provider = 'codex'
    if (fault === 'mode') original.ui.reply.sessionType = 'freshcodex'
    if (fault === 'request') original.ui.reply.requestId = 'unrelated-request'
    if (fault === 'native-observation') original.ui.view.nativeIdentityObservation.nativeSessionId = 'third-unrelated-native'
    rewriteBrowserExecution(built, original)
    expect(() => validateFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt: built.receipt })).toThrow()
    expect(() => buildFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, evidenceDir: built.evidenceDir, candidateSha,
      receiptRunId, runtimeImage, selectedModes: ['freshopencode'], rows: built.receipt.rows })).toThrow()
  })

  it.each(['freshclaude', 'kilroy', 'freshcodex'] as const)('retains the presentation acknowledgment contract for reopened %s originals', mode => {
    const built = fixture([row(mode)], 'production', 'low', true)
    const original = readBrowserExecution(built)
    original.ui.reply.sessionId = original.ui.view.nativeSessionId
    rewriteBrowserExecution(built, original)
    expect(() => validateFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt: built.receipt })).toThrow()
    expect(() => buildFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, evidenceDir: built.evidenceDir, candidateSha,
      receiptRunId, runtimeImage, selectedModes: [mode], rows: built.receipt.rows })).toThrow()
  })

  it.each(['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'] as const)('reopens materialized browser identities for %s without changing observed frames', mode => {
    const built = fixture([row(mode)], 'production', 'low', true)
    expect(validateFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt: built.receipt }).rows).toEqual(built.receipt.rows)
    const original = readBrowserExecution(built)
    expect(original.ui.request.sessionId).toBe(original.allocations[1].view.nativeSessionId)
    expect(original.ui.reply.sessionId).toBe(original.allocations[1].view.freshAgentSessionId)
    expect(original.ui.request.sessionId).not.toBe(original.ui.reply.sessionId)
  })
  it('reopens the actual materialized history create reply on the original native root', () => {
    const built = fixture([row()], 'production', 'low', true)
    const original = readBrowserExecution(built)
    const history = original.routes.find((route: any) => route.ingress === 'history-resume')
    history.request = { type: 'freshAgent.create', requestId: 'actual-history-create', sessionType: 'freshclaude',
      sessionRef: { provider: 'claude', sessionId: history.view.nativeSessionId } }
    history.reply = { type: 'freshAgent.created', requestId: history.request.requestId, sessionId: history.view.nativeSessionId }
    rewriteBrowserExecution(built, original)
    expect(validateFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt: built.receipt }).rows).toEqual(built.receipt.rows)
    for (const fault of ['provider', 'request', 'reply-session']) {
      const invalid = structuredClone(original), route = invalid.routes.find((value: any) => value.ingress === 'history-resume')
      if (fault === 'provider') route.request.sessionRef.provider = 'codex'
      if (fault === 'request') route.reply.requestId = 'unrelated-history-request'
      if (fault === 'reply-session') route.reply.sessionId = route.view.freshAgentSessionId
      rewriteBrowserExecution(built, invalid)
      expect(() => validateFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt: built.receipt })).toThrow()
    }
  })
  it.each(['send-session', 'send-provider', 'send-mode', 'ack-session', 'ack-request', 'ui-presentation', 'ui-root', 'ui-soul', 'ui-incarnation', 'ui-observation', 'history-session', 'history-presentation', 'history-soul', 'history-provider', 'history-observation', 'history-incarnation', 'attach-session', 'attach-presentation', 'attach-incarnation', 'decision-session', 'decision-provider', 'decision-mode', 'decision-presentation', 'dispatch-session', 'dispatch-request', 'dispatch-native-request'])('rejects materialized browser %s from reopened originals', fault => {
    const built = fixture([row()], 'production', 'low', true)
    const original = readBrowserExecution(built), ui = original.ui
    const history = original.routes.find((route: any) => route.ingress === 'history-resume')
    const attach = original.routes.find((route: any) => route.ingress === 'ws-attach')
    const approval = original.approvals[0], dispatch = approval.events[0].data.payload.event
    if (fault === 'send-session') ui.request.sessionId = original.allocations[0].view.nativeSessionId
    if (fault === 'send-provider') ui.request.provider = 'codex'
    if (fault === 'send-mode') ui.request.sessionType = 'freshcodex'
    if (fault === 'ack-session') ui.reply.sessionId = original.allocations[0].view.freshAgentSessionId
    if (fault === 'ack-request') ui.reply.requestId = 'another-command'
    if (fault === 'ui-presentation') ui.view.freshAgentSessionId = 'another-presentation-of-same-root'
    if (fault === 'ui-root') ui.view.nativeSessionId = 'another-native-root'
    if (fault === 'ui-soul') ui.view.soulId = 'another-soul'
    if (fault === 'ui-incarnation') ui.view.incarnationId = ui.view.nativeIdentityObservation.incarnationId = 'old-incarnation'
    if (fault === 'ui-observation') ui.view.nativeIdentityObservation.incarnationId = 'old-incarnation'
    if (fault === 'history-session') history.request.sessionId = original.allocations[1].view.nativeSessionId
    if (fault === 'history-presentation') history.view.freshAgentSessionId = 'another-presentation-of-same-root'
    if (fault === 'history-soul') history.view.soulId = 'another-soul'
    if (fault === 'history-provider') history.request.provider = 'codex'
    if (fault === 'history-observation') history.view.nativeIdentityObservation.incarnationId = 'old-incarnation'
    if (fault === 'history-incarnation') history.view.incarnationId = history.view.nativeIdentityObservation.incarnationId = 'old-incarnation'
    if (fault === 'attach-session') attach.request.sessionId = original.allocations[1].view.nativeSessionId
    if (fault === 'attach-presentation') attach.view.freshAgentSessionId = 'another-presentation-of-same-root'
    if (fault === 'attach-incarnation') attach.view.incarnationId = attach.view.nativeIdentityObservation.incarnationId = 'old-incarnation'
    if (fault === 'decision-session') approval.browserDecision.sessionId = original.allocations[0].view.nativeSessionId
    if (fault === 'decision-provider') approval.browserDecision.provider = 'codex'
    if (fault === 'decision-mode') approval.browserDecision.sessionType = 'freshcodex'
    if (fault === 'decision-presentation') approval.afterView.freshAgentSessionId = approval.recoveryObservation.after.view.freshAgentSessionId = 'another-presentation-of-same-root'
    if (fault === 'dispatch-session') dispatch.sessionId = approval.afterView.freshAgentSessionId
    if (fault === 'dispatch-request') dispatch.requestId = 'another-command'
    if (fault === 'dispatch-native-request') dispatch.nativeRequestId = 'stale-native-request'
    rewriteBrowserExecution(built, original)
    expect(() => validateFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt: built.receipt })).toThrow()
    expect(() => buildFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, evidenceDir: built.evidenceDir, candidateSha, receiptRunId, runtimeImage, selectedModes: ['freshclaude'], rows: built.receipt.rows })).toThrow()
  })
  it('rejects inventory labels without an executed request and current activation', async () => {
    const module = await import('../../../../scripts/testing/fresh-agent-qualification-receipt.js')
    expect(() => (module as any).deriveFreshBrowserExecution({ mode: 'freshcodex', routes: [], allocations: [], lifecycle: [] }, {})).toThrow(/executed ingress/)
  })
  it.each(['approval-native-already-consumed', 'approval-swapped-recovery', 'approval-web-no-restart', 'approval-web-old-restart', 'approval-missing-aux-release', 'approval-aux-release-after-start', 'approval-wrong-exit-process', 'approval-wrong-recovery-root', 'approval-web-process-changed', 'approval-missing-before-files', 'approval-missing-current-files', 'approval-no-native-operation', 'approval-wrong-native-input', 'approval-wrong-checkpoint', 'approval-stale-actor', 'approval-wrong-dispatch-id', 'approval-wrong-native-dispatch', 'alias-wrong-rest-tab', 'alias-wrong-rest-split', 'alias-wrong-mcp-new-tab', 'alias-wrong-mcp-split', 'alias-wrong-request', 'alias-wrong-store', 'alias-stale-writer', 'missing-route', 'wrong-reply', 'two-writers', 'shared-store', 'shared-container', 'release-after-prepare', 'missing-release', 'missing-running', 'web-process-replaced', 'startup-empty', 'approval-missing-deny', 'approval-old-callback', 'approval-effect-replayed', 'approval-duplicate-dispatch', 'approval-extra-completion', 'approval-changed-native-root', 'approval-changed-native-executable'])('reopens originals and rejects %s', fault => {
    const built = fixture()
    const current = built.receipt.rows[0]!, reference = current.executionOriginal as { path: string; sha256: string }
    const filename = path.join(built.evidenceDir, reference.path), original = JSON.parse(fs.readFileSync(filename, 'utf8'))
    if (fault.startsWith('alias-wrong-') && !['alias-wrong-request', 'alias-wrong-store'].includes(fault)) {
      const route = original.routes.find((value: any) => value.ingress === fault.slice('alias-wrong-'.length))
      route.view = original.allocations[1].view; route.reply.sessionId = route.view.freshAgentSessionId
    }
    const alias = original.routes.find((value: any) => value.ingress === 'rest-tab')
    if (fault === 'alias-wrong-request') alias.request.body.sessionRef.sessionId = original.allocations[1].view.nativeSessionId
    if (fault === 'alias-wrong-store') alias.writer.providerStoreId = 'unrelated-store'
    if (fault === 'alias-stale-writer') alias.writer.incarnationId = 'stale-incarnation'
    if (fault === 'missing-route') original.routes.pop()
    if (fault === 'wrong-reply') original.routes[0].reply.requestId = 'another-request'
    if (fault === 'two-writers') original.allocations[0].writer.activeClaimCount = 2
    if (fault === 'shared-store') original.allocations[1].writer.providerStoreId = original.allocations[0].writer.providerStoreId
    if (fault === 'shared-container') original.allocations[1].view.containerId = original.allocations[0].view.containerId
    if (fault === 'release-after-prepare') [original.lifecycle[1], original.lifecycle[2]] = [original.lifecycle[2], original.lifecycle[1]]
    if (fault === 'missing-release') original.lifecycle = original.lifecycle.filter((event: any) => !event.event.endsWith('old_writer_released'))
    if (fault === 'missing-running') original.lifecycle = original.lifecycle.filter((event: any) => event.event !== 'supervisor.launch_running')
    if (fault === 'web-process-replaced') original.webRestarts[0].after.process.native.pid += 1
    if (fault === 'startup-empty') original.supervisorRestarts[0].lifecycle[0].data.scanned = 0
    if (fault === 'approval-missing-deny') original.approvals.pop()
    const approval = original.approvals[2]
    if (fault === 'approval-swapped-recovery') for (const value of original.approvals) if (value.recovery !== 'web') value.recovery = value.recovery === 'host' ? 'provider' : 'host'
    if (fault === 'approval-web-no-restart') delete original.approvals[0].recoveryObservation
    if (fault === 'approval-web-old-restart') original.approvals[0].recoveryObservation.requestedAt = 9
    if (fault === 'approval-missing-aux-release') approval.recoveryObservation.lifecycle.shift()
    if (fault === 'approval-aux-release-after-start') approval.recoveryObservation.lifecycle.reverse()
    if (fault === 'approval-wrong-exit-process') approval.recoveryObservation.nativePid += 1
    if (fault === 'approval-wrong-recovery-root') approval.recoveryObservation.after.view.nativeSessionId = 'unrelated-root'
    if (fault === 'approval-web-process-changed') original.approvals[0].recoveryObservation.after.process.native.pid += 1
    const rewriteNative = (snapshot: any, change: (rows: any[]) => any[]) => {
      const rows = change(Buffer.from(snapshot.transcript.bytesBase64, 'base64').toString().trim().split('\n').map(line => JSON.parse(line)))
      const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      snapshot.transcript.bytesBase64 = bytes.toString('base64'); snapshot.transcript.sha256 = createHash('sha256').update(bytes).digest('hex')
    }
    const rewriteFile = (file: any, change: (value: any) => void) => {
      const value = JSON.parse(Buffer.from(file.bytesBase64, 'base64').toString()); change(value)
      const bytes = Buffer.from(JSON.stringify(value)); file.bytesBase64 = bytes.toString('base64'); file.sha256 = createHash('sha256').update(bytes).digest('hex')
    }
    if (fault === 'approval-missing-before-files') delete approval.beforeFiles
    if (fault === 'approval-missing-current-files') delete approval.currentFiles
    if (fault === 'approval-no-native-operation') for (const snapshot of [approval.beforeNative, approval.currentNative]) rewriteNative(snapshot, () => [{ type: 'system', sessionId: approval.nativeRoot }])
    if (fault === 'approval-native-already-consumed') for (const snapshot of [approval.beforeNative, approval.currentNative]) rewriteNative(snapshot, rows => [...rows, { type: 'user', sessionId: approval.nativeRoot, message: { content: [{ type: 'tool_result', tool_use_id: approval.beforeCard.payload.toolUseID }] } }])
    if (fault === 'approval-wrong-native-input') for (const snapshot of [approval.beforeNative, approval.currentNative]) rewriteNative(snapshot, rows => { rows[0].message.content[0].input.command = 'unrelated operation'; return rows })
    if (fault === 'approval-wrong-checkpoint') rewriteFile(approval.currentFiles[0], value => { value.checkpoint.toolUseID = 'toolu_other' })
    if (fault === 'approval-stale-actor') rewriteFile(approval.currentFiles[1], value => { value.decisions[approval.currentCard.decision_id].payload.nativeBinding.nativeRequestId = 'stale-callback' })
    if (fault === 'approval-wrong-dispatch-id') approval.events[0].data.payload.event.requestId = 'unrelated-decision'
    if (fault === 'approval-wrong-native-dispatch') approval.events[0].data.payload.event.nativeRequestId = 'unrelated-native-callback'
    if (fault === 'approval-old-callback') approval.currentCard.payload.nativeRequestId = approval.beforeCard.payload.nativeRequestId
    if (fault === 'approval-effect-replayed') approval.recheckedEffectCount += 1
    if (fault === 'approval-duplicate-dispatch') approval.events.push(approval.events[0])
    if (fault === 'approval-extra-completion') approval.events.push(approval.events.at(-1))
    if (fault === 'approval-changed-native-root') approval.beforeNative.nativeRoot = approval.currentNative.nativeRoot = 'another-real-root'
    if (fault === 'approval-changed-native-executable') approval.currentNative.executableSha256 = 'f'.repeat(64)
    fs.writeFileSync(filename, JSON.stringify(original))
    current.executionOriginal = { path: reference.path, sha256: createHash('sha256').update(fs.readFileSync(filename)).digest('hex') }
    const assertionsPath = path.join(built.evidenceDir, 'fresh-agent-qualification-assertions.json')
    const assertions = JSON.parse(fs.readFileSync(assertionsPath, 'utf8')); assertions.rows = built.receipt.rows
    fs.writeFileSync(assertionsPath, JSON.stringify(assertions))
    built.receipt.artifacts.assertions.sha256 = createHash('sha256').update(fs.readFileSync(assertionsPath)).digest('hex')
    expect(() => validateFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt: built.receipt })).toThrow()
    expect(() => buildFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, evidenceDir: built.evidenceDir, candidateSha, receiptRunId, runtimeImage, selectedModes: ['freshclaude'], rows: built.receipt.rows })).toThrow()
  })

})

afterEach(() => {
  vi.restoreAllMocks()
  while (tempRoots.length) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

function readBrowserExecution(built: ReturnType<typeof fixture>): any {
  return JSON.parse(fs.readFileSync(path.join(built.evidenceDir, built.receipt.rows[0]!.executionOriginal!.path), 'utf8'))
}

function rewriteBrowserExecution(built: ReturnType<typeof fixture>, original: any): void {
  const current = built.receipt.rows[0]!, filename = path.join(built.evidenceDir, current.executionOriginal!.path)
  fs.writeFileSync(filename, JSON.stringify(original))
  current.executionOriginal!.sha256 = createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
  const assertionsPath = path.join(built.evidenceDir, 'fresh-agent-qualification-assertions.json')
  const assertions = JSON.parse(fs.readFileSync(assertionsPath, 'utf8')); assertions.rows = built.receipt.rows
  fs.writeFileSync(assertionsPath, JSON.stringify(assertions))
  built.receipt.artifacts.assertions.sha256 = createHash('sha256').update(fs.readFileSync(assertionsPath)).digest('hex')
}

function browserOwnerFixture(mode: FreshAgentQualificationRow['mode'] = 'freshclaude') {
  const selected = row(mode)
  const built = fixture([selected])
  const original = readBrowserExecution(built)
  // Source-only cloud checkouts lack Git metadata; the owned fixture supplies its actual candidate.
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Dan Shapiro', '-c', 'user.email=3732858+danshapiro@users.noreply.github.com',
    '-c', 'commit.gpgsign=false', ...args,
  ], { cwd: built.repoRoot, encoding: 'utf8', timeout: 10_000 })
  git('init', '--quiet')
  git('add', 'docker', 'crates')
  git('commit', '--quiet', '-m', 'Owned browser consumer fixture')
  const owner = new ManagedRuntimeOwner(() => { throw new Error('web I/O is unused') }, built.repoRoot, 5)
  const internal = owner as any
  const view = structuredClone(original.allocations[1].view)
  view.freshAgentSessionId = 'presentation-owned-picker-request'
  view.containerId = 'b'.repeat(64)
  const handle = { runId: owner.runtime.runId, candidateSha: owner.runtime.candidateSha, soulId: view.soulId,
    incarnationId: view.incarnationId, containerId: view.containerId, hostBootId: view.hostBootId, nativeSessionId: view.nativeSessionId }
  // Supply serialized inventory and broker facts; the actual current-handle,
  // enclosure, send, approval and dispatch consumers execute unchanged.
  owner.runtime.broker = { receipts: () => [{ ...handle }] } as any
  vi.spyOn(owner, 'inventory').mockResolvedValue([view])
  vi.spyOn(owner.runtime, 'recordLifecycle').mockImplementation(() => undefined)
  const capture = vi.spyOn(internal, 'captureFreshNativeSource').mockResolvedValue({ turns: [{ toolCalls: [], text: 'ready', outcome: 'completed' }] })
  vi.spyOn(internal, 'materializeNativeSource').mockResolvedValue(original.ui.after)
  internal.freshNativeCollections.set('collection', { mode, provider: selected.provider })
  const challenge = { handle, collectionId: 'collection', provider: selected.provider, beforeTurns: 0, prompt: original.ui.request.text, beforeView: structuredClone(view) }
  internal.freshBrowserChallenges.set('ui-challenge', challenge)
  const request = { ...original.ui.request, sessionId: view.nativeSessionId }
  const reply = { ...original.ui.reply, sessionId: view.freshAgentSessionId }
  const approval = structuredClone(original.approvals[0])
  if (approval) {
    approval.soulId = view.soulId
    approval.beforeView = structuredClone(view)
    approval.afterView = structuredClone(view)
    approval.events.unshift({ kind: 'permission_requested', data: approval.beforeCard })
    internal.freshApprovalChallenges.set('approval-challenge', approval)
    vi.spyOn(internal, 'freshApprovalEvents').mockResolvedValue(approval.events.at(-1))
    vi.spyOn(internal, 'freshApprovalEffect').mockResolvedValue(approval.effectCount)
    vi.spyOn(internal, 'readFreshApprovalEvents').mockResolvedValue({ head: 0, events: [] })
    approval.cursor = 0
  }
  const retain = vi.spyOn(internal, 'retainNativeOriginal').mockResolvedValue({ path: 'outcome.json', sha256: 'a'.repeat(64) })
  return { owner, internal, view, handle, challenge, request, reply, approval, capture, retain }
}

describe('materialized browser owner consumers', () => {
  it.each(['failed', 'empty'] as const)('refuses a finalized %s OpenCode answer during collection', async fault => {
    const { owner, handle, request, reply, challenge, capture } = browserOwnerFixture('freshopencode')
    capture.mockResolvedValue({ turns: [{ toolCalls: [], text: fault === 'empty' ? '' : 'partial answer',
      outcome: fault === 'failed' ? 'failed' : 'completed' }] })
    await expect(owner.finishFreshBrowserTurn(handle, 'ui-challenge', request, reply)).rejects.toThrow(/browser no-tool native completion/)
    expect(challenge.finished).not.toBe(true)
  })

  it('finishes materialized OpenCode native acknowledgment on its exact current allocation', async () => {
    const { owner, internal, view, handle, request, reply, challenge, capture } = browserOwnerFixture('freshopencode')
    reply.sessionId = view.nativeSessionId
    reply.provider = 'opencode'
    reply.sessionType = 'freshopencode'
    await expect(owner.finishFreshBrowserTurn(handle, 'ui-challenge', request, reply)).resolves.toBeUndefined()
    expect(capture).toHaveBeenCalledExactlyOnceWith(handle, 'opencode')
    expect(challenge.finished).toBe(true)
    expect(internal.freshBrowserCollections.get('collection').ui.reply.sessionId).toBe(view.nativeSessionId)
  })

  it.each(['foreign-session', 'provider', 'mode', 'request', 'native-observation', 'incarnation'])('rejects a materialized OpenCode native acknowledgment with %s before capture', async fault => {
    const { owner, view, handle, request, reply, capture } = browserOwnerFixture('freshopencode')
    reply.sessionId = view.nativeSessionId
    reply.provider = 'opencode'
    reply.sessionType = 'freshopencode'
    if (fault === 'foreign-session') reply.sessionId = 'third-unrelated-native'
    if (fault === 'provider') reply.provider = 'codex'
    if (fault === 'mode') reply.sessionType = 'freshcodex'
    if (fault === 'request') reply.requestId = 'unrelated-request'
    if (fault === 'native-observation') view.nativeIdentityObservation.nativeSessionId = 'third-unrelated-native'
    if (fault === 'incarnation') view.nativeIdentityObservation.incarnationId = 'old-incarnation'
    await expect(owner.finishFreshBrowserTurn(handle, 'ui-challenge', request, reply)).rejects.toThrow()
    expect(capture).not.toHaveBeenCalled()
  })

  it.each(['freshclaude', 'kilroy', 'freshcodex'] as const)('retains the presentation acknowledgment contract for the actual %s owner', async mode => {
    const { owner, view, handle, request, reply, capture } = browserOwnerFixture(mode)
    reply.sessionId = view.nativeSessionId
    await expect(owner.finishFreshBrowserTurn(handle, 'ui-challenge', request, reply)).rejects.toThrow()
    expect(capture).not.toHaveBeenCalled()
  })

  it.each(['history-resume', 'ws-attach'] as const)('records the actual %s native attach on its registered allocation', async ingress => {
    const { owner, internal, handle, view } = browserOwnerFixture()
    Object.assign(internal.freshNativeCollections.get('collection'), { soulId: view.soulId, nativeSessionId: view.nativeSessionId })
    const observation = { ingress, request: { type: 'freshAgent.attach', sessionId: view.nativeSessionId, provider: 'claude', sessionType: 'freshclaude' } }
    await expect(owner.observeFreshBrowserIngress(handle, 'collection', observation)).resolves.toBeUndefined()
    expect(internal.freshBrowserCollections.get('collection').routes[0]).toMatchObject({ ...observation, view })
  })
  it.each(['wrong-attach-session', 'wrong-attach-provider', 'wrong-attach-mode', 'wrong-attach-allocation', 'stale-attach-observation'])('rejects %s in the actual ingress consumer', async fault => {
    const { owner, internal, handle, view } = browserOwnerFixture()
    Object.assign(internal.freshNativeCollections.get('collection'), { soulId: view.soulId, nativeSessionId: view.nativeSessionId })
    const request = { type: 'freshAgent.attach', sessionId: view.nativeSessionId, provider: 'claude', sessionType: 'freshclaude' }
    if (fault === 'wrong-attach-session') request.sessionId = 'foreign-native'
    if (fault === 'wrong-attach-provider') request.provider = 'codex'
    if (fault === 'wrong-attach-mode') request.sessionType = 'freshcodex'
    if (fault === 'wrong-attach-allocation') internal.freshNativeCollections.get('collection').soulId = 'another-soul-of-same-root'
    if (fault === 'stale-attach-observation') view.nativeIdentityObservation.incarnationId = 'old-incarnation'
    await expect(owner.observeFreshBrowserIngress(handle, 'collection', { ingress: 'history-resume', request })).rejects.toThrow()
    expect(internal.freshBrowserCollections.get('collection').routes).toEqual([])
  })
  it.each(['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'] as const)('finishes the actual %s native send with its presentation acknowledgment and retains both frames', async mode => {
    const { owner, internal, handle, request, reply, challenge } = browserOwnerFixture(mode)
    await expect(owner.finishFreshBrowserTurn(handle, 'ui-challenge', request, reply)).resolves.toBeUndefined()
    expect(internal.freshBrowserCollections.get('collection').ui).toMatchObject({ request, reply, view: challenge.beforeView })
    expect(challenge.finished).toBe(true)
  })
  it('finishes the actual native approval response and raw native dispatch', async () => {
    const { owner, handle, approval, retain } = browserOwnerFixture()
    await expect(owner.finishFreshApproval(handle, 'approval-challenge', approval.browserDecision)).resolves.toBeUndefined()
    expect(approval.finished).toBe(true)
    expect(retain).toHaveBeenCalledWith('fresh-approval-approval-challenge/outcome.json', approval)
  })
  it.each(['wrong-send-session', 'wrong-send-provider', 'wrong-send-mode', 'wrong-ack-session', 'wrong-request', 'wrong-presentation', 'wrong-native-root', 'wrong-provider', 'stale-observation', 'stale-incarnation', 'foreign-owner'])('rejects %s before native send collection', async fault => {
    const { owner, view, handle, request, reply, capture } = browserOwnerFixture()
    if (fault === 'wrong-send-session') request.sessionId = 'foreign-native'
    if (fault === 'wrong-send-provider') request.provider = 'codex'
    if (fault === 'wrong-send-mode') request.sessionType = 'freshcodex'
    if (fault === 'wrong-ack-session') reply.sessionId = 'foreign-presentation'
    if (fault === 'wrong-request') reply.requestId = 'foreign-request'
    if (fault === 'wrong-presentation') view.freshAgentSessionId = 'another-presentation-of-same-root'
    if (fault === 'wrong-native-root') view.nativeSessionId = 'foreign-native'
    if (fault === 'wrong-provider') view.provider = 'codex'
    if (fault === 'stale-observation') view.nativeIdentityObservation.incarnationId = 'old-incarnation'
    if (fault === 'stale-incarnation') view.incarnationId = 'old-incarnation'
    if (fault === 'foreign-owner') handle.runId = 'foreign-run'
    await expect(owner.finishFreshBrowserTurn(handle, 'ui-challenge', request, reply)).rejects.toThrow()
    expect(capture).not.toHaveBeenCalled()
  })
  it.each(['wrong-decision-session', 'wrong-decision-provider', 'wrong-decision-mode', 'wrong-decision-request', 'wrong-presentation', 'wrong-native-root', 'wrong-provider', 'stale-observation', 'stale-incarnation', 'foreign-owner'])('rejects %s before native approval settlement', async fault => {
    const { owner, view, handle, approval, retain } = browserOwnerFixture()
    if (fault === 'wrong-decision-session') approval.browserDecision.sessionId = 'foreign-native'
    if (fault === 'wrong-decision-provider') approval.browserDecision.provider = 'codex'
    if (fault === 'wrong-decision-mode') approval.browserDecision.sessionType = 'freshcodex'
    if (fault === 'wrong-decision-request') approval.browserDecision.requestId = 'foreign-request'
    if (fault === 'wrong-presentation') view.freshAgentSessionId = 'another-presentation-of-same-root'
    if (fault === 'wrong-native-root') view.nativeSessionId = 'foreign-native'
    if (fault === 'wrong-provider') view.provider = 'codex'
    if (fault === 'stale-observation') view.nativeIdentityObservation.incarnationId = 'old-incarnation'
    if (fault === 'stale-incarnation') view.incarnationId = 'old-incarnation'
    if (fault === 'foreign-owner') handle.runId = 'foreign-run'
    await expect(owner.finishFreshApproval(handle, 'approval-challenge', approval.browserDecision)).rejects.toThrow()
    expect(retain).not.toHaveBeenCalled()
  })
})

function row(mode: FreshAgentQualificationRow['mode'] = 'freshclaude'): FreshAgentQualificationRow {
  const definitions = {
    freshclaude: { provider: 'claude', version: '2.1.237', model: 'haiku', effort: 'low', variant: 'claude-agent-sdk', pending: true },
    kilroy: { provider: 'claude', version: '2.1.237', model: 'haiku', effort: 'low', variant: 'kilroy-claude-agent-sdk', pending: true },
    freshcodex: { provider: 'codex', version: '0.147.0', model: 'gpt-5.6-luna', effort: 'low', variant: 'codex-app-server', pending: false },
    freshopencode: { provider: 'opencode', version: '1.18.21', model: 'opencode/big-pickle', effort: 'provider-default', variant: 'opencode-per-soul-http', pending: false },
  } as const
  const definition = definitions[mode]
  return {
    mode,
    provider: definition.provider,
    providerVersion: definition.version,
    model: definition.model,
    effort: definition.effort,
    runtimeVariant: definition.variant,
    actualProviderProcess: true,
    fixtureTransport: false,
    ingresses: FRESH_AGENT_INGRESS_INVENTORY.map(({ ingress }) => ingress),
    soulId: `soul-${mode}`,
    nativeSessionId: `native-${mode}`,
    providerStoreId: `store-${mode}`,
    completedNativeTurns: [
      { turnId: `${mode === 'freshopencode' ? 'assistant' : 'turn'}-${mode}-1`, assistantMessageId: `assistant-${mode}-1`, completionKind: 'provider_native_completed' },
      { turnId: `${mode === 'freshopencode' ? 'assistant' : 'turn'}-${mode}-2`, assistantMessageId: `assistant-${mode}-2`, completionKind: 'provider_native_completed' },
      { turnId: `${mode === 'freshopencode' ? 'assistant' : 'turn'}-${mode}-3`, assistantMessageId: `assistant-${mode}-3`, completionKind: 'provider_native_completed' },
    ],
    noToolRecall: true,
    crashes: {
      web: ['abrupt_restart'],
      host: ['session_host_exit', 'provider_process_exit'],
    },
    pendingApproval: definition.pending
      ? { supported: true, survivedWebRestart: true, survivedHostRecovery: true, resolvedExactlyOnce: true, decisionIdHash: createHash('sha256').update(['web', 'host', 'provider'].flatMap(recovery => [true, false].map(allowed => 'decision-' + mode + '-' + recovery + '-' + allowed)).join('\n')).digest('hex') }
      : { supported: false },
    writerProof: {
      activeWriterCount: 1,
      conflictingWriterCount: 0,
      dispatchCountForPrompt: 1,
      completionCountForPrompt: 1,
    },
    isolation: {
      providerVolumeNameHash: createHash('sha256').update('owned-volume').digest('hex'),
      enclosureIdHash: createHash('sha256').update('container-2').digest('hex'),
      independentProviderStore: true,
      independentEnclosure: true,
    },
    limits: {
      cpuMax: '50000 100000',
      memoryMax: '268435456',
      swapMax: '0',
      pidsMax: '64',
    },
    oldEnclosure: {
      verifiedEmptyBeforeResume: true,
      writerClaimReleasedBeforeResume: true,
    },
  }
}


function browserExecutionFixture(current: FreshAgentQualificationRow, stages: any[], evidenceDir: string, write: (name: string, value: any) => { path: string; sha256: string }, prefix: string, materialized = false) {
  const read = (reference: any) => JSON.parse(fs.readFileSync(path.join(evidenceDir, reference.path), 'utf8'))
  const stageViews = stages.map(stage => read(stage.launch).response.data.view)
  const view = { ...stageViews.at(-1), provider: current.mode === 'kilroy' ? 'kilroy' : current.provider, freshAgentSessionType: current.mode, freshAgentSessionId: materialized ? 'presentation-' + current.nativeSessionId : current.nativeSessionId }
  const native = read(read(stages.at(-1).profile).process)
  const allocation = { view, writer: { soulId: current.soulId, incarnationId: view.incarnationId, nativeSessionId: current.nativeSessionId,
    providerStoreId: current.providerStoreId, activeClaimCount: 1, globalConflictingClaimCount: 0 }, volume: { providerVolumeName: 'owned-volume' }, process: native, limits: current.limits }
  const otherRoot = 'other-' + current.nativeSessionId
  const other = structuredClone(allocation)
  Object.assign(other.view, { soulId: 'other-soul', incarnationId: 'other-inc', containerId: 'other-container', nativeSessionId: otherRoot, freshAgentSessionId: materialized ? 'presentation-' + otherRoot : otherRoot,
    nativeIdentityObservation: { ...view.nativeIdentityObservation, nativeSessionId: otherRoot, incarnationId: 'other-inc' } })
  Object.assign(other.writer, { soulId: other.view.soulId, incarnationId: other.view.incarnationId, nativeSessionId: otherRoot, providerStoreId: 'other-store' })
  other.volume.providerVolumeName = 'other-volume'; other.process.native.launch.incarnationId = other.view.incarnationId
  const routes = FRESH_AGENT_INGRESS_INVENTORY.filter(({ ingress }) => !['startup-restore', 'auto-resume'].includes(ingress)).map(({ ingress }) => {
    const target = ingress === 'browser-split' ? other.view : view
    const requestId = 'create-' + ingress
    if (materialized && ingress === 'history-resume') return { ingress, view: target, request: { type: 'freshAgent.attach', sessionId: target.nativeSessionId } }
    if (['browser-picker', 'browser-split', 'ws-create', 'history-resume'].includes(ingress)) return { ingress, view: target,
      request: { type: 'freshAgent.create', requestId, sessionType: current.mode, ...(ingress === 'history-resume' ? { sessionRef: { provider: current.provider, sessionId: target.nativeSessionId } } : {}) },
      reply: { type: 'freshAgent.created', requestId, sessionId: target.freshAgentSessionId } }
    if (ingress === 'ws-attach') return { ingress, view: target, request: { type: 'freshAgent.attach', sessionId: materialized ? target.nativeSessionId : target.freshAgentSessionId } }
    return { ingress, view: target, writer: structuredClone(allocation.writer), request: { method: 'POST', path: ingress.endsWith('split') ? '/api/panes/actual-pane/split' : '/api/tabs', body: { agent: current.mode, sessionRef: { provider: current.provider, sessionId: target.nativeSessionId } } },
      reply: { paneId: 'actual-pane', sessionId: materialized ? target.nativeSessionId : target.freshAgentSessionId } }
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
    reply: { type: 'freshAgent.send.accepted', requestId: 'actual-ui-send', sessionId: other.view.freshAgentSessionId } }
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

function fixture(
  rows = [row()],
  buildKind: 'production' | 'deterministic_fixture' = 'production',
  nativeEffort: string | null = 'low',
  materialized = false,
): {
  repoRoot: string
  evidenceDir: string
  receipt: ReturnType<typeof buildFreshAgentQualificationReceipt>
} {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-agent-qualification-'))
  tempRoots.push(repoRoot)
  const evidenceDir = path.join(repoRoot, '.runtime-evidence', candidateSha, receiptRunId)
  fs.mkdirSync(evidenceDir, { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'docker/runtime'), { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'crates/freshell-claude-sidecar'), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, 'crates/freshell-claude-sidecar/package.json'), JSON.stringify({ dependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.237' } }))
  fs.writeFileSync(path.join(repoRoot, 'docker/runtime/provider-versions.json'), JSON.stringify({
    providers: {
      claude: { version: '2.1.263', sdkVersion: '0.3.237', sdkNativeVersion: '2.1.237' },
      codex: { version: '0.147.0' },
      opencode: { version: '1.18.21' },
    },
  }))
  fs.writeFileSync(path.join(evidenceDir, 'manifest.json'), JSON.stringify({
    execution: { candidateSha, runId: receiptRunId },
  }))
  fs.writeFileSync(path.join(evidenceDir, 'build.json'), JSON.stringify({
    candidateSha,
    runtimeImage,
    freshAgentQualificationBuild: {
      kind: buildKind,
      serverFeatures: [buildKind === 'production' ? 'managed-runtime-v1' : 'managed-fresh-agent-fixtures'],
      sessionHostFeatures: buildKind === 'production' ? [] : ['fresh-agent-fixtures'],
      selectedModes: rows.map((candidate) => candidate.mode),
      fixtureModes: buildKind === 'production' ? [] : rows.map((candidate) => candidate.mode),
    },
    binaries: {
      server: { sha256: '1'.repeat(64) },
      supervisor: { sha256: '2'.repeat(64) },
      sessionHost: { sha256: '3'.repeat(64) },
    },
  }))
  fs.writeFileSync(path.join(evidenceDir, 'broker.jsonl'), `${JSON.stringify({ unsafeAttempt: false })}\n`)
  fs.writeFileSync(path.join(evidenceDir, 'cleanup.json'), JSON.stringify({
    ok: true,
    errors: [],
    unsafeBrokerAttempts: [],
  }))
  const original = (name: string, value: unknown) => {
    const filename = path.join(evidenceDir, name); fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify({ execution: { candidateSha, runId: receiptRunId, runtimeImage }, ...value as Record<string, unknown> }), { mode: 0o600 })
    return { path: name, sha256: createHash('sha256').update(fs.readFileSync(filename)).digest('hex') }
  }
  const conversations = rows.map((currentRow, rowIndex) => {
    const nonce = `owned-memory-${currentRow.mode}-1234567890`, nativeSessionId = currentRow.nativeSessionId || 'invalid-root'
    const nativeRows: unknown[] = []
    const stages = ['initial', 'after_session_host_crash', 'after_provider_process_crash'].map((stage, index) => {
      const base = 1_780_000_000_000 + index * 10_000, prompt = index ? 'Recall the saved marker. Do not use tools.' : `Remember ${nonce}. Reply stored. Do not use tools.`
      const turnId = `turn-${currentRow.mode}-${index + 1}`, messageId = `assistant-${currentRow.mode}-${index + 1}`, userId = `user-${index}`
      const response = index ? nonce : 'stored', prefix = `originals-${rowIndex}/stage-${index}`
      let nativeFile: { path: string; sha256: string }
      if (currentRow.provider === 'opencode') {
        const filename = path.join(evidenceDir, prefix, 'opencode.db'); fs.mkdirSync(path.dirname(filename), { recursive: true })
        const db = new DatabaseSync(filename)
        db.exec('CREATE TABLE session(id TEXT PRIMARY KEY); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);')
        db.prepare('INSERT INTO session VALUES (?)').run(nativeSessionId)
        nativeRows.push({ id: userId, at: base + 2_000, data: { role: 'user' }, text: prompt }, { id: messageId, at: base + 3_000, data: { role: 'assistant', parentID: userId, providerID: 'opencode', modelID: 'big-pickle', time: { completed: base + 3_000 } }, text: response })
        for (const value of nativeRows as any[]) {
          db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(value.id, nativeSessionId, value.at, JSON.stringify(value.data))
          db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('part-' + value.id, nativeSessionId, value.id, value.at, JSON.stringify({ type: 'text', text: value.text }))
        }
        db.close(); nativeFile = { path: `${prefix}/opencode.db`, sha256: createHash('sha256').update(fs.readFileSync(filename)).digest('hex') }
      } else {
        if (currentRow.provider === 'codex') nativeRows.push({ type: 'turn_context', payload: { turn_id: turnId, model: 'gpt-5.6-luna', effort: 'low' } }, { type: 'event_msg', payload: { type: 'user_message', message: prompt } }, { type: 'response_item', payload: { type: 'message', role: 'assistant', id: messageId, content: [{ type: 'output_text', text: response }] } }, { type: 'event_msg', timestamp: new Date(base + 3_000).toISOString(), payload: { type: 'task_complete', turn_id: turnId, last_agent_message: response } })
        else nativeRows.push({ type: 'user', uuid: userId, sessionId: nativeSessionId, message: { role: 'user', content: prompt } }, { type: 'assistant', uuid: messageId, parentUuid: userId, sessionId: nativeSessionId, timestamp: new Date(base + 3_000).toISOString(), effort: nativeEffort ?? undefined, message: { id: turnId, role: 'assistant', model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text: response }] } })
        const sourceRows = currentRow.provider === 'codex' ? [{ type: 'session_meta', payload: { id: nativeSessionId, model_provider: 'openai' } }, ...nativeRows] : nativeRows
        nativeFile = original(`${prefix}/${currentRow.provider === 'codex' ? 'rollout-' : ''}${nativeSessionId}.jsonl`, sourceRows.map(value => JSON.stringify(value)).join('\n') + '\n')
      }
      const launch = original(`${prefix}/launch.json`, { capturedAt: base + 1_000, response: { data: { view: { soulId: currentRow.soulId, providerStoreId: currentRow.providerStoreId, nativeSessionId, incarnationId: `inc-${index}`, containerId: `container-${index}`, hostBootId: `boot-${index}`, executionGeneration: index + 1, launchState: 'running', recoveryState: 'live', nativeIdentityObservation: { nativeSessionId, incarnationId: `inc-${index}`, launchNonce: `launch-${index}`, evidenceRevision: index, evidenceDigest: 'c'.repeat(64) } } } } })
      const request = original(`${prefix}/request.json`, { requestId: `request-${index}`, sentAt: base + 2_000, request: { method: 'fresh_agent_send', params: { soulId: currentRow.soulId, text: prompt } }, reply: { data: {} } })
      const crash = index ? original(`${prefix}/crash.json`, { kind: index === 1 ? 'session_host_exit' : 'provider_process_exit', containerId: `container-${index - 1}`, incarnationId: `inc-${index - 1}`, requestedAt: base - 2_000, exitedAt: base - 1_000 }) : undefined
      const namespace = original(`${prefix}/namespace.json`, { uid: 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true,
        httpsStatus: currentRow.mode === 'freshopencode' ? null : 200,
        ...(currentRow.mode === 'freshopencode' ? { freeModelAccess: { source: 'native-config-providers', providerId: 'opencode', modelId: 'big-pickle', endpoint: 'https://unit-free.invalid/v1', ca: 'system-default', peerCertificateSha256: 'a'.repeat(64) } } : {}),
        tlsVerifyMode: 2, tlsCheckHostname: true, nativeRoot: nativeSessionId, nativeCwd: '/owned/workspace', nativePid: 55 + index, ownedProbe: { containerId: `container-${index}`, nativePid: 55 + index, capturedAt: base + 1_500 }, executableSha256: 'd'.repeat(64), profileSha256: 'e'.repeat(64) })
      const bytes = fs.readFileSync(path.join(evidenceDir, nativeFile.path))
      const store = original(`${prefix}/store.json`, { containerId: `container-${index}`, providerVolumeName: 'owned-volume', snapshot: { path: '/owned/native-store', identity: ['1', '2'], completeEof: true, bytesBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') } })
      const packageSource = original(`${prefix}/sdk-package.json`, JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.237', claudeCodeVersion: '2.1.237' }))
      const moduleSource = original(`${prefix}/sdk-module.mjs`, 'export const query = () => undefined;')
      const entrySource = original(`${prefix}/sidecar-entry.mjs`, 'import { query } from "@anthropic-ai/claude-agent-sdk";')
      const process = original(`${prefix}/process.json`, { provider: currentRow.provider, version: currentRow.providerVersion,
        native: { pid: 55 + index, parentPid: 54 + index, uid: 65534, startTicks: String(100 + index), executable: `/owned/${currentRow.provider}`, executableSha256: 'd'.repeat(64), profileSha256: 'e'.repeat(64), cwd: '/owned/workspace', configuredModel: currentRow.provider === 'claude' ? 'haiku' : null, configuredEffort: currentRow.provider === 'claude' ? 'low' : null, launch: { incarnationId: `inc-${index}`, launchNonce: `launch-${index}`, executionGeneration: index + 1, evidenceRevision: index } },
        sdk: currentRow.provider === 'claude' ? { version: '0.3.237', declaredNativeVersion: '2.1.237', selection: 'sidecar-selected-module-resolution', packageSource, moduleSource, entrySource, moduleSha256: moduleSource.sha256, entrySha256: entrySource.sha256 } : null })
      const accepted = original(`${prefix}/accepted.json`, { source: 'registry-current-incarnation', soulId: currentRow.soulId, incarnationId: `inc-${index}`, containerId: `container-${index}`, hostBootId: `boot-${index}`, launchNonce: `launch-${index}`, executionGeneration: index + 1, providerStoreId: currentRow.providerStoreId, nativeSessionId,
        spec: { sessionType: currentRow.mode, provider: currentRow.mode === 'kilroy' ? 'kilroy' : currentRow.provider, runtimeVariant: currentRow.runtimeVariant, providerStoreId: currentRow.providerStoreId, nativeSessionId, cwd: '/owned/workspace', model: currentRow.model, effort: currentRow.effort === 'provider-default' ? null : currentRow.effort, providerSecretReferences: [] } })
      const profile = original(`${prefix}/profile.json`, { mode: currentRow.mode, process, accepted })
      return { stage, launch, request, nativeFile, namespace, store, profile, ...(crash ? { crash } : {}) }
    })
    const last = stages.at(-1)!
    const stoppedView = { soulId: currentRow.soulId, nativeSessionId, incarnationId: 'inc-2', containerId: 'container-2', hostBootId: 'boot-2', executionGeneration: 3,
      provider: currentRow.mode === 'kilroy' ? 'kilroy' : currentRow.provider, launchState: 'stopped', desiredState: 'stopped', cleanupState: 'verified_empty' }
    const stopped = original(`originals-${rowIndex}/stopped.json`, { nativeFile: last.nativeFile, store: last.store,
      stopResult: { outcome: 'verified_empty', view: stoppedView }, stoppedView,
      writer: { provider: stoppedView.provider, soulId: currentRow.soulId, incarnationId: stoppedView.incarnationId, providerStoreId: currentRow.providerStoreId, nativeSessionId, activeClaimCount: 0, globalConflictingClaimCount: 0 },
      stopCompletedAt: 1_780_000_024_000, stoppedObservedAt: 1_780_000_024_100, writerObservedAt: 1_780_000_024_200,
      readStartedAt: 1_780_000_024_300, readCompletedAt: 1_780_000_024_400, completedTurnCount: 3 })
    currentRow.executionOriginal = browserExecutionFixture(currentRow, stages, evidenceDir, original, 'browser-' + rowIndex, materialized)
    return { mode: currentRow.mode, provider: currentRow.provider, soulId: currentRow.soulId, providerStoreId: currentRow.providerStoreId, nativeSessionId, nonce, stages, stopped }
  })
  original('native-recovery-originals.json', { schemaVersion: 1, candidateSha, runId: receiptRunId, runtimeImage, selected: rows.map(current => current.mode), conversations })
  const receipt = buildFreshAgentQualificationReceipt({
    repoRoot,
    evidenceDir,
    candidateSha,
    receiptRunId,
    runtimeImage,
    selectedModes: rows.map((candidate) => candidate.mode),
    rows,
  })
  return { repoRoot, evidenceDir, receipt }
}

describe('fresh-agent live mode selection', () => {
  it('accepts an explicit ordered subset so each mode can run independently', () => {
    expect(parseFreshAgentQualificationModes('freshcodex')).toEqual(['freshcodex'])
    expect(parseFreshAgentQualificationModes('kilroy,freshopencode')).toEqual(['kilroy', 'freshopencode'])
  })

  it.each(['', 'all', 'freshclaude,freshclaude', 'claude', 'freshcodex, freshopencode', 'unknown']) (
    'rejects empty, broadened, duplicate, aliased, or unknown selection %j before launch',
    (value) => expect(() => parseFreshAgentQualificationModes(value)).toThrow(FRESH_AGENT_QUALIFICATION_MODES_ENV),
  )

  it.each(['false', 'missing'])('rejects qualification when a selectable mode loses readiness (%s)', (state) => {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../docs/development/runtime-provider-capabilities.json'),
      'utf8',
    ))
    const candidate = manifest.freshAgentModes.find((entry: { mode: string }) => entry.mode === 'freshcodex')
    if (state === 'false') candidate.qualificationReady = false
    else delete candidate.qualificationReady
    expect(() => parseFreshAgentQualificationModes('freshclaude', manifest))
      .toThrow(/freshcodex.*qualificationReady/i)
  })
})

function disabledFreshManifest() {
  const manifest = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../../../docs/development/runtime-provider-capabilities.json'), 'utf8',
  ))
  for (const row of manifest.freshAgentModes) {
    Object.assign(row, { enabledInReleaseScope: false, certified: false,
      liveQualificationStatus: 'pending_authentic_receipt', releaseDeferralReason: 'pending_live_provider_certification' })
    Object.assign(manifest.doorways.find((doorway: { id: string }) => doorway.id === `rest-${row.mode}-create`),
      { policy: 'blocked', enabledInReleaseScope: false })
  }
  manifest.releaseScope.freshAgentEnabled = false
  manifest.releaseScope.disabledFreshAgentModes = manifest.freshAgentModes.map((row: { mode: string }) => row.mode)
  return manifest
}

describe('fresh-agent release scope truth', () => {
  it('requires current native receipts for the retained production candidate', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../docs/development/runtime-provider-capabilities.json'), 'utf8',
    ))
    const built = fixture()
    const input = { manifest, repoRoot: built.repoRoot, candidateSha, runtimeImage,
      envName: 'CANDIDATE_FRESH_RECEIPT', raw: undefined as string | undefined }
    expect(() => releasedFreshAgentReceiptRows(input)).toThrow(/required.*freshclaude,freshcodex,freshopencode/i)
    expect(() => releasedFreshAgentReceiptRows({ ...input, raw: JSON.stringify(built.receipt) }))
      .toThrow(/do not exactly match release scope/i)
    expect(() => releasedFreshAgentReceiptRows({ ...input,
      raw: JSON.stringify({ ...built.receipt, candidateSha: 'b'.repeat(40) }),
    })).toThrow(/candidate/i)
    expect(() => releasedFreshAgentReceiptRows({ ...input,
      raw: JSON.stringify({ ...built.receipt, runtimeImage: `sha256:${'c'.repeat(64)}` }),
    })).toThrow(/image/i)
    fs.writeFileSync(path.join(built.evidenceDir, 'cleanup.json'), JSON.stringify({ ok: false, errors: ['synthetic-failure'], unsafeBrokerAttempts: [] }))
    built.receipt.artifacts.cleanup.sha256 = createHash('sha256')
      .update(fs.readFileSync(path.join(built.evidenceDir, 'cleanup.json'))).digest('hex')
    expect(() => releasedFreshAgentReceiptRows({ ...input, raw: JSON.stringify(built.receipt) })).toThrow(/cleanup/i)
  })

  it('fails if host-owned code is released without live certification', () => {
    const manifest = disabledFreshManifest()
    manifest.freshAgentModes[0].enabledInReleaseScope = true
    expect(freshAgentReleaseScopeViolations(manifest, []).join(' ')).toMatch(/freshclaude.*live|receipt|certif/i)
  })

  it('rejects a disabled fresh adapter without an explicit live deferral', () => {
    const manifest = disabledFreshManifest()
    manifest.freshAgentModes[0].releaseDeferralReason = 'missing_mcp'
    expect(freshAgentReleaseScopeViolations(manifest, []).join(' ')).toMatch(/freshclaude.*live.*deferral/i)
  })

  it('keeps the global fresh-agent flag equal to the per-mode release scope', () => {
    const manifest = disabledFreshManifest()
    manifest.releaseScope.freshAgentEnabled = true
    expect(freshAgentReleaseScopeViolations(manifest, []).join(' ')).toMatch(/freshAgentEnabled/i)
  })

  it('fails if a disabled fresh mode is accidentally counted as PASS', () => {
    const manifest = disabledFreshManifest()
    expect(freshAgentReleaseScopeViolations(manifest, ['freshcodex']).join(' '))
      .toMatch(/freshcodex.*disabled.*PASS/i)
  })

  it('requires the release disabled-mode list to match fresh mode rows exactly', () => {
    const manifest = disabledFreshManifest()
    manifest.releaseScope.disabledFreshAgentModes.pop()
    expect(freshAgentReleaseScopeViolations(manifest, []).join(' ')).toMatch(/disabledFreshAgentModes/i)
  })

  it('requires no receipt while all modes remain disabled and rejects a disabled PASS row', () => {
    const manifest = disabledFreshManifest()
    const base = {
      manifest,
      repoRoot: path.resolve(__dirname, '../../../..'),
      candidateSha,
      runtimeImage,
      envName: 'FRESHELL_RUNTIME_PHASE3_FRESH_AGENT_RECEIPT',
    }
    expect(releasedFreshAgentReceiptRows({ ...base, raw: undefined })).toEqual([])
    expect(() => releasedFreshAgentReceiptRows({
      ...base,
      raw: JSON.stringify({ rows: [{ mode: 'freshclaude' }] }),
    })).toThrow(/freshclaude.*disabled.*PASS/i)
  })

  it('requires the isolated producer to name exactly one mode', () => {
    expect(selectedFreshAgentModeFromArgs(['--mode', 'freshcodex'])).toBe('freshcodex')
    expect(() => selectedFreshAgentModeFromArgs([])).toThrow(/usage/i)
    expect(() => selectedFreshAgentModeFromArgs(['freshclaude,kilroy'])).toThrow(/exactly one/i)
  })
})

describe('fresh-agent qualification receipt v1', () => {
  it('binds exact candidate, run, image, selected mode, native proof, and hashed artifacts', () => {
    const built = fixture()
    expect(built.receipt).toMatchObject({
      schemaVersion: 1,
      lane: 'fresh_agent_live',
      status: 'PASS',
      candidateSha,
      receiptRunId,
      runtimeImage,
      selectedModes: ['freshclaude'],
      rows: [{ mode: 'freshclaude', provider: 'claude', runtimeVariant: 'claude-agent-sdk' }],
    })
    expect(Object.values(built.receipt.artifacts).every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true)
    expect(validateFreshAgentQualificationReceipt({
      repoRoot: built.repoRoot,
      candidateSha,
      expectedRuntimeImage: runtimeImage,
      receipt: built.receipt,
    }).rows).toEqual([{ ...row(), executionOriginal: built.receipt.rows[0]!.executionOriginal }])
  })

  it('never accepts a deterministic fixture build as live-provider evidence', () => {
    expect(() => fixture([row()], 'deterministic_fixture')).toThrow(/fixtures cannot satisfy/i)
  })

  it.each(['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'] as const)(
    'accepts a truthful independent %s row',
    (mode) => expect(fixture([row(mode)]).receipt.selectedModes).toEqual([mode]),
  )

  it('validates grant-free FreshOpenCode with actual free native completed messages and unknown effort', () => {
    const built = fixture([row('freshopencode')])
    expect(validateFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt: built.receipt }).rows[0]).toMatchObject({ model: 'opencode/big-pickle', effort: 'provider-default' })
  })

  it.each(['requested-model', 'accepted-model', 'accepted-grant', 'native-provider', 'native-model', 'access-provider', 'access-model', 'access-ca', 'access-tls', 'access-missing', 'fabricated-http-status'])('reopens free native originals and refuses %s in builder and validator', fault => {
    const built = fixture([row('freshopencode')]), current = built.receipt.rows[0]!
    const manifestFile = path.join(built.evidenceDir, 'native-recovery-originals.json')
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')), stage = manifest.conversations[0].stages[0]
    const update = (reference: any, mutate: (value: any) => void) => {
      const filename = path.join(built.evidenceDir, reference.path), value = JSON.parse(fs.readFileSync(filename, 'utf8'))
      mutate(value); fs.writeFileSync(filename, JSON.stringify(value)); reference.sha256 = createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
    }
    if (fault === 'requested-model') current.model = 'openai/gpt-5.6-luna'
    if (fault.startsWith('accepted-')) {
      const profile = JSON.parse(fs.readFileSync(path.join(built.evidenceDir, stage.profile.path), 'utf8'))
      update(profile.accepted, value => { if (fault === 'accepted-model') value.spec.model = 'openai/gpt-5.6-luna'; else value.spec.providerSecretReferences = [{ profile: 'opencode_onecli_environment', sourcePath: '/unit/unreadable' }] })
      update(stage.profile, value => { value.accepted = profile.accepted })
    }
    if (fault.startsWith('native-')) {
      const filename = path.join(built.evidenceDir, stage.nativeFile.path), db = new DatabaseSync(filename)
      const assistant = db.prepare("SELECT id,data FROM message WHERE json_extract(data,'$.role')='assistant'").get() as { id: string; data: string }
      const data = JSON.parse(assistant.data); data[fault === 'native-provider' ? 'providerID' : 'modelID'] = fault === 'native-provider' ? 'openai' : 'paid-model'
      db.prepare('UPDATE message SET data=? WHERE id=?').run(JSON.stringify(data), assistant.id); db.close()
      const bytes = fs.readFileSync(filename); stage.nativeFile.sha256 = createHash('sha256').update(bytes).digest('hex')
      update(stage.store, value => { value.snapshot.bytesBase64 = bytes.toString('base64'); value.snapshot.sha256 = stage.nativeFile.sha256 })
    }
    if (fault.startsWith('access-') || fault === 'fabricated-http-status') update(stage.namespace, value => {
      if (fault === 'access-provider') value.freeModelAccess.providerId = 'openai'
      if (fault === 'access-model') value.freeModelAccess.modelId = 'paid-model'
      if (fault === 'access-ca') value.freeModelAccess.ca = 'onecli-managed'
      if (fault === 'access-tls') value.tlsVerifyMode = 0
      if (fault === 'access-missing') delete value.freeModelAccess
      if (fault === 'fabricated-http-status') value.httpsStatus = 200
    })
    fs.writeFileSync(manifestFile, JSON.stringify(manifest))
    built.receipt.artifacts.nativeOriginals.sha256 = createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex')
    const assertionsFile = path.join(built.evidenceDir, 'fresh-agent-qualification-assertions.json')
    const assertions = JSON.parse(fs.readFileSync(assertionsFile, 'utf8')); assertions.rows = built.receipt.rows
    fs.writeFileSync(assertionsFile, JSON.stringify(assertions)); built.receipt.artifacts.assertions.sha256 = createHash('sha256').update(fs.readFileSync(assertionsFile)).digest('hex')
    expect(() => buildFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, evidenceDir: built.evidenceDir, candidateSha, receiptRunId, runtimeImage, selectedModes: ['freshopencode'], rows: built.receipt.rows })).toThrow()
    expect(() => validateFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt: built.receipt })).toThrow()
  })

  it('requires retained current profile originals even with valid recomputed summary hashes', () => {
    const built = fixture()
    const filename = path.join(built.evidenceDir, 'native-recovery-originals.json')
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'))
    delete manifest.conversations[0].stages[1].profile
    fs.writeFileSync(filename, JSON.stringify(manifest))
    const build = () => buildFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, evidenceDir: built.evidenceDir,
      candidateSha, receiptRunId, runtimeImage, selectedModes: ['freshclaude'], rows: [row()] })
    expect(build).toThrow(/profile/)
    built.receipt.artifacts.nativeOriginals.sha256 = createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
    expect(() => validateFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, candidateSha,
      expectedRuntimeImage: runtimeImage, receipt: built.receipt })).toThrow(/profile/)
  })

  it('qualifies requested low with unknown optional native effort and refuses invented observed low', () => {
    const built = fixture([row()], 'production', null)
    const manifestFile = path.join(built.evidenceDir, 'native-recovery-originals.json')
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    manifest.conversations[0].stages[1].observedReasoningEffort = 'low'
    fs.writeFileSync(manifestFile, JSON.stringify(manifest))
    built.receipt.artifacts.nativeOriginals.sha256 = createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex')
    expect(() => buildFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, evidenceDir: built.evidenceDir, candidateSha,
      receiptRunId, runtimeImage, selectedModes: ['freshclaude'], rows: [row()] })).toThrow(/absent.*telemetry/)
    expect(() => validateFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, candidateSha,
      expectedRuntimeImage: runtimeImage, receipt: built.receipt })).toThrow(/absent.*telemetry/)
  })

  it.each(['sdk', 'pid', 'accepted-model', 'stale-profile', 'native-model'] as const)('reopens valid-hash %s originals in both builder and validator', (mutation) => {
    const built = fixture()
    const manifestFile = path.join(built.evidenceDir, 'native-recovery-originals.json')
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    const stage = manifest.conversations[0].stages[1]
    const rewrite = (reference: { path: string; sha256: string }, change: (source: any) => void) => {
      const filename = path.join(built.evidenceDir, reference.path), source = JSON.parse(fs.readFileSync(filename, 'utf8'))
      change(source); fs.writeFileSync(filename, JSON.stringify(source)); reference.sha256 = createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
    }
    const profileFile = path.join(built.evidenceDir, stage.profile.path), profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'))
    if (mutation === 'sdk') rewrite(profile.process, source => { source.sdk.version = '0.3.236' })
    if (mutation === 'pid') rewrite(profile.process, source => { source.native.pid = 999 })
    if (mutation === 'accepted-model') rewrite(profile.accepted, source => { source.spec.model = 'sonnet' })
    if (mutation === 'stale-profile') stage.profile = manifest.conversations[0].stages[0].profile
    else {
      fs.writeFileSync(profileFile, JSON.stringify(profile)); stage.profile.sha256 = createHash('sha256').update(fs.readFileSync(profileFile)).digest('hex')
    }
    if (mutation === 'native-model') {
      const file = path.join(built.evidenceDir, stage.nativeFile.path)
      const raw = fs.readFileSync(file, 'utf8').replaceAll('claude-haiku-4-5-20251001', 'claude-sonnet-4-6')
      fs.writeFileSync(file, raw); stage.nativeFile.sha256 = createHash('sha256').update(raw).digest('hex')
      rewrite(stage.store, source => { source.snapshot.bytesBase64 = Buffer.from(raw).toString('base64'); source.snapshot.sha256 = stage.nativeFile.sha256 })
    }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest)); built.receipt.artifacts.nativeOriginals.sha256 = createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex')
    expect(() => buildFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, evidenceDir: built.evidenceDir, candidateSha,
      receiptRunId, runtimeImage, selectedModes: ['freshclaude'], rows: [row()] })).toThrow(/SDK|profile|prefix|model/)
    expect(() => validateFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, candidateSha,
      expectedRuntimeImage: runtimeImage, receipt: built.receipt })).toThrow(/SDK|profile|prefix|model/)
  })

  it('requires the retained final stopped raw source after a complete live-stage collection', () => {
    const built = fixture()
    const manifestFile = path.join(built.evidenceDir, 'native-recovery-originals.json')
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); delete manifest.conversations[0].stopped
    fs.writeFileSync(manifestFile, JSON.stringify(manifest))
    expect(() => buildFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, evidenceDir: built.evidenceDir, candidateSha,
      receiptRunId, runtimeImage, selectedModes: ['freshclaude'], rows: [row()] })).toThrow(/stopped/)
  })

  it.each(['missing-stop', 'blocked-stop', 'missing-stopped-view', 'live-stop-view', 'live-inventory', 'missing-writer',
    'active-writer', 'conflicting-writer', 'wrong-store', 'wrong-writer-soul', 'wrong-writer-root', 'wrong-writer-incarnation', 'wrong-writer-provider',
    'wrong-stop-soul', 'wrong-stop-root', 'wrong-stop-container', 'wrong-stop-boot', 'wrong-inventory-incarnation', 'wrong-inventory-generation',
    'missing-read-order', 'read-before-stop', 'writer-after-read', 'stop-before-completion'] as const)(
    'refuses valid-hash final stopped association %s in both builder and validator', mutation => {
      const built = fixture(), manifestFile = path.join(built.evidenceDir, 'native-recovery-originals.json')
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')), reference = manifest.conversations[0].stopped
      const filename = path.join(built.evidenceDir, reference.path), stopped = JSON.parse(fs.readFileSync(filename, 'utf8'))
      if (mutation === 'missing-stop') delete stopped.stopResult
      if (mutation === 'blocked-stop') stopped.stopResult.outcome = 'blocked_ownership'
      if (mutation === 'missing-stopped-view') delete stopped.stoppedView
      if (mutation === 'live-stop-view') stopped.stopResult.view.launchState = 'running'
      if (mutation === 'live-inventory') stopped.stoppedView.desiredState = 'running'
      if (mutation === 'missing-writer') delete stopped.writer
      if (mutation === 'active-writer') stopped.writer.activeClaimCount = 1
      if (mutation === 'conflicting-writer') stopped.writer.globalConflictingClaimCount = 1
      const writerFields: Partial<Record<typeof mutation, string>> = { 'wrong-store': 'providerStoreId', 'wrong-writer-soul': 'soulId', 'wrong-writer-root': 'nativeSessionId', 'wrong-writer-incarnation': 'incarnationId', 'wrong-writer-provider': 'provider' }
      const writerField = writerFields[mutation]
      if (writerField) stopped.writer[writerField] = 'another-writer'
      const stopFields: Partial<Record<typeof mutation, string>> = { 'wrong-stop-soul': 'soulId', 'wrong-stop-root': 'nativeSessionId', 'wrong-stop-container': 'containerId', 'wrong-stop-boot': 'hostBootId' }
      const stopField = stopFields[mutation]
      if (stopField) stopped.stopResult.view[stopField] = 'another-stopped-source'
      if (mutation === 'wrong-inventory-incarnation') stopped.stoppedView.incarnationId = 'previous-incarnation'
      if (mutation === 'wrong-inventory-generation') stopped.stoppedView.executionGeneration = 2
      if (mutation === 'missing-read-order') delete stopped.readStartedAt
      if (mutation === 'read-before-stop') stopped.readStartedAt = stopped.stopCompletedAt - 1
      if (mutation === 'writer-after-read') stopped.writerObservedAt = stopped.readCompletedAt + 1
      if (mutation === 'stop-before-completion') stopped.stopCompletedAt = 1_780_000_022_999
      fs.writeFileSync(filename, JSON.stringify(stopped)); reference.sha256 = createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
      fs.writeFileSync(manifestFile, JSON.stringify(manifest)); built.receipt.artifacts.nativeOriginals.sha256 = createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex')
      const refusal = [() => buildFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, evidenceDir: built.evidenceDir, candidateSha,
        receiptRunId, runtimeImage, selectedModes: ['freshclaude'], rows: [row()] }),
      () => validateFreshAgentQualificationReceipt({ repoRoot: built.repoRoot, candidateSha, expectedRuntimeImage: runtimeImage, receipt: built.receipt })]
        .map(operation => { try { operation(); return 'accepted' } catch (error) { return (error as Error).message } })
      expect(refusal).toEqual([expect.stringMatching(/stopped|Stop|writer|read order/), expect.stringMatching(/stopped|Stop|writer|read order/)])
    },
  )

  it('keeps Kilroy distinct from FreshClaude by provider runtime variant', () => {
    expect(() => fixture([{ ...row('kilroy'), runtimeVariant: 'claude-agent-sdk' }])).toThrow(/kilroy.*runtimeVariant/i)
  })

  it('rejects legacy, missing, duplicate, and zero-test evidence', () => {
    const built = fixture()
    const validate = (receipt: unknown) => validateFreshAgentQualificationReceipt({
      repoRoot: built.repoRoot,
      candidateSha,
      expectedRuntimeImage: runtimeImage,
      receipt,
    })
    expect(() => validate({ ...built.receipt, schemaVersion: 0 })).toThrow(/schema/i)
    expect(() => validate({ ...built.receipt, rows: [] })).toThrow(/row|mode/i)
    expect(() => fixture([row(), row()])).toThrow(/duplicate/i)
    expect(() => fixture([{ ...row(), completedNativeTurns: [] }])).toThrow(/completedNativeTurns/i)
    expect(() => validate({ ...built.receipt, receiptRunId: 'stale-run' })).toThrow(/evidence run|run id/i)
  })

  it('requires exact native identities, two completed native turns, no-tool recall, and one dispatch/completion', () => {
    expect(() => fixture([{ ...row(), nativeSessionId: '' }])).toThrow(/nativeSessionId/i)
    expect(() => fixture([{ ...row(), completedNativeTurns: [row().completedNativeTurns[0]] }])).toThrow(/completedNativeTurns/i)
    expect(() => fixture([{ ...row(), noToolRecall: false }])).toThrow(/noToolRecall/i)
    expect(() => fixture([{ ...row(), writerProof: { ...row().writerProof, dispatchCountForPrompt: 2 } }])).toThrow(/dispatchCountForPrompt/i)
  })

  it('requires web, host, and provider crashes plus pending-decision survival where supported', () => {
    expect(() => fixture([{ ...row(), crashes: { web: [], host: ['session_host_exit', 'provider_process_exit'] } }])).toThrow(/web.*crash/i)
    expect(() => fixture([{ ...row(), crashes: { web: ['abrupt_restart'], host: ['session_host_exit'] } }])).toThrow(/provider_process_exit/i)
    expect(() => fixture([{ ...row(), pendingApproval: { ...row().pendingApproval, survivedWebRestart: false } }])).toThrow(/pendingApproval/i)
    expect(() => fixture([{ ...row('freshcodex'), pendingApproval: { supported: true } }])).toThrow(/pendingApproval/i)
  })

  it('requires independent stores/enclosures, bounded resources with swap disabled, and old enclosure emptiness', () => {
    expect(() => fixture([{ ...row(), isolation: { ...row().isolation, independentProviderStore: false } }])).toThrow(/independentProviderStore/i)
    expect(() => fixture([{ ...row(), limits: { ...row().limits, swapMax: 'max' } }])).toThrow(/swapMax/i)
    expect(() => fixture([{ ...row(), limits: { ...row().limits, memoryMax: 'max' } }])).toThrow(/memoryMax/i)
    expect(() => fixture([{ ...row(), oldEnclosure: { ...row().oldEnclosure, verifiedEmptyBeforeResume: false } }])).toThrow(/verifiedEmptyBeforeResume/i)
  })

  it.each(['candidate', 'assertions', 'broker', 'cleanup'] as const)('rejects tampered %s evidence', (artifact) => {
    const built = fixture()
    const name = built.receipt.artifacts[artifact].path.split('/').at(-1)!
    fs.appendFileSync(path.join(built.evidenceDir, name), '\ntampered\n')
    expect(() => validateFreshAgentQualificationReceipt({
      repoRoot: built.repoRoot,
      candidateSha,
      expectedRuntimeImage: runtimeImage,
      receipt: built.receipt,
    })).toThrow(/digest|sha-256/i)
  })

  it('derives broker and cleanup truth from evidence', () => {
    const unsafe = fixture()
    fs.appendFileSync(path.join(unsafe.evidenceDir, 'broker.jsonl'), `${JSON.stringify({ unsafeAttempt: true })}\n`)
    expect(() => buildFreshAgentQualificationReceipt({
      repoRoot: unsafe.repoRoot,
      evidenceDir: unsafe.evidenceDir,
      candidateSha,
      receiptRunId,
      runtimeImage,
      selectedModes: ['freshclaude'],
      rows: [row()],
    })).toThrow(/unsafe/i)
  })

  it.each(['responseText', 'prompt', 'credentialValue', 'rawProviderEvents', 'workspaceData'])(
    'forbids sensitive or echo-like receipt field %s recursively',
    (field) => expect(() => fixture([{ ...row(), proof: { [field]: 'must-not-be-retained' } }])).toThrow(/forbidden|sensitive/i),
  )
})
