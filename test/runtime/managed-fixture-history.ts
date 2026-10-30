import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import WebSocket from 'ws'
import { z } from 'zod'
import { ManagedRuntimeOwner, verifyRuntimeCleanupAbsence } from '../../scripts/testing/runtime-sandbox.js'
import { ManagedRuntimeWebServer } from '../../scripts/testing/runtime-external-browser.js'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol.js'
import { FRESHCLAUDE_DEFAULT_EFFORT } from '../../shared/fresh-agent-models.js'
import { FreshAgentSnapshotSchema } from '../../shared/fresh-agent-contract.js'
import { SessionDirectoryPageSchema, SessionDirectoryQuerySchema } from '../../shared/read-models.js'

// One genuine provider-UID fixture save, the Docker native reader, and the
// authenticated directory. This does not exercise a browser or a real model.
const root = fs.realpathSync(path.resolve(import.meta.dirname, '../..'))
let boundary = 'prerequisite'
const log = (event: string, facts: Record<string, unknown> = {}) => {
  process.stdout.write(JSON.stringify({ severity: 'info', event, boundary, ...facts }) + '\n')
}

async function waitFor<T>(probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('bounded fixture observation expired')
}

class Wire {
  readonly frames: any[] = []
  private malformed = false
  private socketError = false
  constructor(readonly socket: WebSocket) {
    socket.on('message', data => {
      try {
        if (this.frames.length >= 256) this.malformed = true
        else this.frames.push(JSON.parse(String(data)))
      } catch { this.malformed = true }
    })
    socket.on('error', () => { this.socketError = true })
  }
  async ready(token: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('owned websocket open expired')), 90_000)
      this.socket.once('open', () => { clearTimeout(timer); resolve() })
      this.socket.once('error', () => { clearTimeout(timer); reject(new Error('owned websocket open failed')) })
    })
    this.socket.send(JSON.stringify({ type: 'hello', token, protocolVersion: WS_PROTOCOL_VERSION }))
    await this.wait(frame => frame.type === 'ready')
  }
  async wait(select: (frame: any) => boolean): Promise<any> {
    return waitFor(async () => {
      assert(!this.malformed && !this.socketError, 'owned websocket observation invalid')
      return this.frames.find(select)
    })
  }
  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => this.socket.terminate(), 2000)
      this.socket.once('close', () => { clearTimeout(timer); resolve() })
      this.socket.close()
    })
  }
}

async function main(): Promise<void> {
  assert.equal(process.env.FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST, '1', 'explicit fixture intent required')
  assert.equal(process.argv.length, 2, 'this regression has exactly one fixed case')
  assert.equal(execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' }).trim(), '10.34.5')
  assert.match(execFileSync('rustc', ['--version'], { cwd: root, encoding: 'utf8' }), /^rustc 1\.96\.1 /)
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '', 'clean committed candidate required')
  const owner = new ManagedRuntimeOwner(options => new ManagedRuntimeWebServer({ ...options, preserveHomeOnStop: false }), root, 3,
    {}, { FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '250' }, 'test', {
      enabledProviders: [], freshAgentModes: ['freshclaude'], fixtureFreshAgentModes: ['freshclaude'],
      providerSettings: { freshclaude: {} },
    }, undefined, { bootstrapProviders: [] })
  let wire: Wire | undefined
  let originalOrdinal = 0
  const retain = (name: string, value: unknown) => owner.runtime.writeArtifact(
    `fixture-history-${++originalOrdinal}-${name}.json`, value)
  const facts: Record<string, unknown> = { runId: owner.runtime.runId, candidateSha: owner.runtime.candidateSha }
  let failure: unknown
  try {
    boundary = 'owner-start'
    log('managed_fixture_history_started', facts)
    const info = await owner.start()
    assert.notEqual(info.port, 3001)
    facts.runtimeImageDigest = owner.runtime.imageRef
    facts.webPid = info.pid
    facts.port = info.port
    retain('web-process', { pid: info.pid, start: fs.readFileSync(`/proc/${info.pid}/stat`, 'utf8'),
      cwd: fs.realpathSync(`/proc/${info.pid}/cwd`), build: JSON.parse(fs.readFileSync(path.join(owner.runtime.evidenceDir, 'build.json'), 'utf8')) })
    boundary = 'create'
    wire = new Wire(new WebSocket(info.wsUrl))
    await wire.ready(info.token)
    const requestId = `history-create-${randomUUID()}`
    const create = { type: 'freshAgent.create', requestId, tabId: `history-tab-${randomUUID()}`,
      namingHandle: `nh-${randomUUID()}`, sessionType: 'freshclaude', provider: 'claude', cwd: root,
      model: 'opus[1m]', permissionMode: 'bypassPermissions', effort: FRESHCLAUDE_DEFAULT_EFFORT }
    wire.socket.send(JSON.stringify(create))
    const ack = await wire.wait(frame => frame.requestId === requestId
      && ['freshAgent.created', 'freshAgent.create.failed'].includes(frame.type))
    retain('creation', { create, firstAck: ack })
    assert.equal(ack.type, 'freshAgent.created', 'original creation refused')
    assert.equal(ack.provider, 'claude')
    assert.equal(ack.runtimeProvider, 'claude')
    assert.equal(ack.sessionType, 'freshclaude')
    assert.equal(typeof ack.sessionId, 'string')
    const view = await waitFor(async () => {
      const inventory = await owner.inventory()
      assert.equal(inventory.length, 1, 'exactly one managed allocation required')
      const selected = inventory.filter(row => row.freshAgentSessionId === ack.sessionId)
      assert.equal(selected.length, 1, 'original presentation identity must select exactly one allocation')
      return selected[0].launchState === 'running' ? selected[0] : undefined
    })
    assert.equal(view.provider, 'claude')
    assert.equal(view.freshAgentSessionType, 'freshclaude')
    assert.equal(view.profile, 'default_agent')
    const handle = owner.exactRuntimeHandle(view)
    assert.match(handle.nativeSessionId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
    assert.deepEqual(ack.sessionRef, { provider: 'claude', sessionId: handle.nativeSessionId })
    retain('initial-inventory', { inventory: await owner.inventory(), handle })
    Object.assign(facts, handle)
    boundary = 'worker-profile'
    await owner.assertCurrentHandle(handle)
    const worker = await owner.fixtureWorkerFacts(handle)
    const host = await owner.chaosHostFacts(handle)
    assert.equal(host.workerLaunchCount, 1)
    assert.equal(host.unsafeBrokerAttempts, 0)
    // Read only this fixture's allowlisted profile fields and its actual worker
    // UID. The production-only phase-five native launch API is inapplicable.
    const profile = JSON.parse(await owner.ownedProviderExec(handle.containerId, ['node', '-e',
      "const fs=require('node:fs');const state=JSON.parse(fs.readFileSync('/home/freshell/provider/.freshell-fixture/provider-native-state.json'));const p=state.createProfile;const o=JSON.parse(fs.readFileSync('/home/freshell/provider/.freshell-fixture/provider-child-observation.json'));const s=fs.readFileSync('/proc/'+process.argv[1]+'/status','utf8');console.log(JSON.stringify({provider:p.provider,cwd:p.cwd,model:p.model,effort:p.effort,permissionMode:p.permissionMode,sandbox:p.sandbox,providerStoreId:p.providerStoreId,requestedNativeSessionId:p.nativeSessionId,nativeSessionId:state.nativeSessionId,uid:Number(s.match(/^Uid:\\s+(\\d+)/m)[1]),argv:o.argv,onecliControlPresent:o.onecliControlPresent}))",
      String(worker.workerPid)]))
    retain('worker-profile', { worker, host, profile })
    assert.equal(profile.uid, 65534)
    assert.deepEqual(profile.argv, ['fresh-agent-fixture-worker', '--provider', 'claude'])
    assert.equal(profile.onecliControlPresent, false)
    assert.equal(profile.provider, 'claude')
    assert.equal(profile.cwd, root)
    assert.equal(profile.model, create.model)
    assert.equal(profile.effort, create.effort)
    assert.equal(profile.permissionMode, create.permissionMode)
    assert.equal(profile.nativeSessionId, handle.nativeSessionId)
    assert.equal(profile.requestedNativeSessionId, null)
    assert.equal(profile.providerStoreId, handle.soulId)
    const receipts = owner.runtime.broker.receipts().filter(row => row.containerId === handle.containerId)
    assert.equal(receipts.length, 1)
    assert(receipts[0].providerVolumeName, 'actual owned provider volume required')
    retain('store-ownership', { containerId: handle.containerId, providerVolumeName: receipts[0].providerVolumeName,
      soulId: handle.soulId, incarnationId: handle.incarnationId })
    const before = await owner.fixtureNativeState(handle)
    assert.equal(before.dispatchCount, 0)
    assert.equal(before.completionCount, 0)
    boundary = 'send'
    await owner.assertCurrentHandle(handle)
    const sendId = `history-send-${randomUUID()}`
    const send = await owner.runtime.adminOk(owner.supervisor, { method: 'fresh_agent_send',
      params: { soulId: handle.soulId, text: 'deterministic saved fixture turn for freshclaude',
        expectedControlEpoch: await owner.controlEpoch() } }, { requestId: sendId })
    retain('send', { requestId: sendId, handle, result: send })
    boundary = 'saved-materialization'
    const events: any[] = []
    let cursor = 0
    await waitFor(async () => {
      await owner.assertCurrentHandle(handle)
      const batch = await owner.runtime.adminOk(owner.supervisor, { method: 'fresh_agent_read_events',
        params: { soulId: handle.soulId, afterSequence: cursor, maxEvents: 128,
          expectedControlEpoch: await owner.controlEpoch() } })
      retain('event-batch', batch)
      assert.equal(batch.kind, 'fresh_agent_events')
      assert.equal(z.boolean().parse(batch.data.resetRequired), false, 'event retention gap')
      events.push(...batch.data.events.map((row: any) => row.event))
      assert(events.length <= 256, 'finite event limit exceeded')
      cursor = batch.data.events.at(-1)?.sequence ?? batch.data.head
      const payloads = events.filter(event => event.kind === 'provider').map(event => event.data.payload)
      const materialized = payloads.filter(event => event.type === 'freshAgent.session.materialized')
      const completed = payloads.filter(event => event.type === 'freshAgent.turn.complete')
      const outcomes = events.filter(event => event.kind === 'command_outcome')
      if (!materialized.length || !completed.length || !outcomes.some(event => event.data.request_id === sendId
        && event.data.state === 'provider_acked')) return undefined
      assert(outcomes.every(event => event.data.request_id === sendId), 'unowned fixture input observed')
      assert.equal(materialized.length, 1)
      assert.equal(completed.length, 1)
      assert.equal(materialized[0].sessionId, handle.nativeSessionId)
      assert.equal(materialized[0].provider, 'claude')
      assert.equal(completed[0].sessionId, handle.nativeSessionId)
      assert.equal(completed[0].completionKind, 'provider_native_completed')
      return true
    })
    const completedState = await owner.fixtureNativeState(handle)
    assert.equal(completedState.dispatchCount, 1)
    assert.equal(completedState.completionCount, 1)
    const inventoryBefore = await owner.inventory()
    retain('completed', { completedState, inventoryBefore, events })
    boundary = 'native-reader'
    await owner.assertCurrentHandle(handle)
    const history = await owner.runtime.adminRaw(owner.supervisor, { method: 'fresh_agent_read_history',
      params: { soulId: handle.soulId, expectedControlEpoch: await owner.controlEpoch() } })
    retain('native-reader-original', history)
    facts.nativeRefusalCode = history.result.Err?.code ?? null
    log('managed_fixture_history_native_reply', { ...facts, ok: !!history.result.Ok })
    assert(!history.result.Err, 'actual native-history-only helper refused')
    assert.equal(history.result.Ok?.kind, 'fresh_agent_history')
    // The supervisor adds presentation context outside the strict native
    // snapshot contract. Validate that context separately without admitting
    // any other extra native field.
    const { managedDirectory, ...nativeSnapshot } = history.result.Ok.data
    const native = FreshAgentSnapshotSchema.parse(nativeSnapshot)
    assert.equal(native.provider, 'claude')
    assert.equal(native.threadId, handle.nativeSessionId)
    assert.equal(native.sessionType, 'freshclaude')
    assert(native.turns.length > 0, 'actual saved native turns missing')
    const completed = events.filter(event => event.kind === 'provider')
      .map(event => event.data.payload).find(event => event.type === 'freshAgent.turn.complete')
    const assistants = native.turns.filter(turn => turn.role === 'assistant')
    assert.equal(assistants.length, 1, 'one actual saved assistant completion required')
    assert.equal(assistants[0].messageId, completed.assistantMessageId,
      'native reader must return the completion saved by this actual Send')
    const binding = z.object({ incarnationId: z.string().min(1), cwd: z.string().min(1),
      workspacePath: z.string().min(1), gitCommonDir: z.string().nullable(),
      sessionType: z.literal('freshclaude') }).strict().parse(managedDirectory)
    assert.equal(binding.incarnationId, handle.incarnationId)
    assert.equal(binding.cwd, root)
    assert.equal(binding.workspacePath, root)
    assert.equal(binding.sessionType, 'freshclaude')
    assert.equal(binding.gitCommonDir, path.resolve(root,
      execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()))
    const activity = history.result.Ok.data.extensions.claude.nativeHistoryActivity
    assert(Number.isSafeInteger(activity.at) && activity.at >= 0, 'integer native activity required')
    facts.nativeReader = { ok: true, turnCount: native.turns.length, activityType: typeof activity.at,
      activitySource: activity.source, incarnationMatches: true, cwdMatches: true }
    boundary = 'session-directory'
    await owner.assertCurrentHandle(handle)
    // api.ts fetchSidebarSessionsSnapshot uses title/visible/limit50 with
    // undefined visibility flags. Its browser imports require browser aliases;
    // apply the same shared query schema and omit its default title parameter.
    const query = SessionDirectoryQuerySchema.parse({ tier: 'title', priority: 'visible', limit: 50 })
    const response = await fetch(`${info.baseUrl}/api/session-directory?priority=${query.priority}&limit=${query.limit}`,
      { headers: { 'x-auth-token': info.token }, signal: AbortSignal.timeout(60_000) })
    const responseText = await response.text()
    retain('directory-original', { status: response.status, body: responseText })
    facts.directoryStatus = response.status
    assert.equal(response.status, 200, 'authenticated session directory request failed')
    const page = SessionDirectoryPageSchema.parse(JSON.parse(responseText))
    const matches = page.items.filter(item => item.provider === 'claude' && item.sessionId === handle.nativeSessionId)
    facts.directory = { validatedItems: page.items.length, matchingItems: matches.length,
      partial: page.partial ?? false, partialReason: page.partialReason ?? null, integrity: page.integrityError?.kind ?? null }
    log('managed_fixture_history_directory_reply', facts)
    assert.equal(matches.length, 1, 'completed exact provider/root must appear once in actual directory')
    assert.equal(matches[0].sessionType, 'freshclaude')
    assert.equal(matches[0].cwd, root)
    assert.equal(matches[0].checkoutPath, root)
    assert.equal(matches[0].projectPath, path.dirname(binding.gitCommonDir!))
    assert(!page.partial && !page.integrityError, 'directory projection is incomplete')
    boundary = 'unchanged-owner'
    await owner.assertCurrentHandle(handle)
    assert.deepEqual(await owner.inventory(), inventoryBefore)
    assert.deepEqual(await owner.fixtureNativeState(handle), completedState)
    assert.deepEqual(await owner.fixtureWorkerFacts(handle), worker)
    assert.equal((await owner.chaosHostFacts(handle)).workerLaunchCount, 1)
    assert.equal((await owner.ownershipFacts()).unsafeBrokerAttempts, 0)
    assert.equal(wire.frames.filter(frame => frame.type === 'freshAgent.created' && frame.requestId === requestId).length, 1)
    retain('unchanged-owner', { inventory: await owner.inventory(), completedState, worker })
    facts.outcome = 'native-and-directory-pass'
  } catch (error) {
    failure = error
    facts.failureBoundary = boundary
    facts.errorCategory = error instanceof z.ZodError ? 'contract-validation' : error instanceof assert.AssertionError ? 'assertion' : 'operation-error'
  } finally {
    boundary = 'cleanup'
    try { await wire?.close() } finally {
      const cleanup = await owner.stop()
      retain('cleanup-result', cleanup)
      assert(cleanup.ok && cleanup.errors.length === 0, 'exact owner cleanup failed')
      const closure = JSON.parse(fs.readFileSync(path.join(owner.runtime.evidenceDir, 'cleanup.json'), 'utf8'))
      assert(closure.brokerSettlementComplete && closure.verifiedKnownResourcesAbsent && closure.verifiedResourcesAbsent,
        'owned broker/resource closure is incomplete')
      const lines = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
      verifyRuntimeCleanupAbsence({ containerIds: closure.exactContainerIds, volumes: closure.volumes,
        helperNames: closure.historyHelperNames }, { containerIds: lines(['ps', '-aq', '--no-trunc']),
        volumes: lines(['volume', 'ls', '--format', '{{.Name}}']), containerNames: lines(['ps', '-a', '--format', '{{.Names}}']) })
      facts.cleanup = { ok: true, errors: 0, brokerSettlementComplete: true, knownResourcesAbsent: true,
        containers: closure.exactContainerIds.length, volumes: closure.volumes.length, helpers: closure.historyHelperNames.length }
      retain('safe-result', facts)
      log('managed_fixture_history_finished', facts)
    }
  }
  if (failure) throw new Error('managed fixture History regression failed at ' + facts.failureBoundary)
}

main().catch(() => {
  process.stderr.write(JSON.stringify({ severity: 'error', event: 'managed_fixture_history_failed', boundary }) + '\n')
  process.exitCode = 1
})
