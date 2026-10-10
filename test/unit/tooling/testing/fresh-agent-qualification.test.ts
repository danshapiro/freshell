// @vitest-environment node
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

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
  releasedFreshAgentModes,
} from '../../../../scripts/testing/provider-certification.js'
import { releasedFreshAgentReceiptRows } from '../../../../scripts/testing/fresh-agent-release-gate.js'
import { selectedFreshAgentModeFromArgs } from '../../../../scripts/testing/runtime-fresh-agent-qualification.js'
import { FRESH_AGENT_INGRESS_INVENTORY } from '../../../../scripts/testing/fresh-agent-ingress-inventory.js'

const candidateSha = 'a'.repeat(40)
const runtimeImage = `sha256:${'b'.repeat(64)}`
const receiptRunId = 'fresh-agent-live-001'
const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

function row(mode: FreshAgentQualificationRow['mode'] = 'freshclaude'): FreshAgentQualificationRow {
  const definitions = {
    freshclaude: { provider: 'claude', version: '2.1.237', model: 'haiku', effort: 'low', variant: 'claude-agent-sdk', pending: true },
    kilroy: { provider: 'claude', version: '2.1.237', model: 'haiku', effort: 'low', variant: 'kilroy-claude-agent-sdk', pending: true },
    freshcodex: { provider: 'codex', version: '0.147.0', model: 'gpt-5.6-luna', effort: 'low', variant: 'codex-app-server', pending: false },
    freshopencode: { provider: 'opencode', version: '1.18.21', model: 'openai/gpt-5.6-luna', effort: 'provider-default', variant: 'opencode-per-soul-http', pending: false },
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
      ? { supported: true, survivedWebRestart: true, survivedHostRecovery: true, resolvedExactlyOnce: true, decisionIdHash: 'd'.repeat(64) }
      : { supported: false },
    writerProof: {
      activeWriterCount: 1,
      conflictingWriterCount: 0,
      dispatchCountForPrompt: 1,
      completionCountForPrompt: 1,
    },
    isolation: {
      providerVolumeNameHash: 'e'.repeat(64),
      enclosureIdHash: 'f'.repeat(64),
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

function fixture(
  rows = [row()],
  buildKind: 'production' | 'deterministic_fixture' = 'production',
  nativeEffort: string | null = 'low',
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
        nativeRows.push({ id: userId, at: base + 2_000, data: { role: 'user' }, text: prompt }, { id: messageId, at: base + 3_000, data: { role: 'assistant', parentID: userId, providerID: 'openai', modelID: 'gpt-5.6-luna', time: { completed: base + 3_000 } }, text: response })
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
      const namespace = original(`${prefix}/namespace.json`, { uid: 65534, gid: 0, caps: '0000000000000000', readOnlyRoot: true, httpsStatus: 200, tlsVerifyMode: 2, tlsCheckHostname: true, nativeRoot: nativeSessionId, nativeCwd: '/owned/workspace', nativePid: 55 + index, ownedProbe: { containerId: `container-${index}`, nativePid: 55 + index, capturedAt: base + 1_500 }, executableSha256: 'd'.repeat(64), profileSha256: 'e'.repeat(64) })
      const bytes = fs.readFileSync(path.join(evidenceDir, nativeFile.path))
      const store = original(`${prefix}/store.json`, { containerId: `container-${index}`, providerVolumeName: 'owned-volume', snapshot: { path: '/owned/native-store', identity: ['1', '2'], completeEof: true, bytesBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') } })
      const packageSource = original(`${prefix}/sdk-package.json`, JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.237', claudeCodeVersion: '2.1.237' }))
      const moduleSource = original(`${prefix}/sdk-module.mjs`, 'export const query = () => undefined;')
      const entrySource = original(`${prefix}/sidecar-entry.mjs`, 'import { query } from "@anthropic-ai/claude-agent-sdk";')
      const process = original(`${prefix}/process.json`, { provider: currentRow.provider, version: currentRow.providerVersion,
        native: { pid: 55 + index, parentPid: 54 + index, uid: 65534, startTicks: String(100 + index), executable: `/owned/${currentRow.provider}`, executableSha256: 'd'.repeat(64), profileSha256: 'e'.repeat(64), cwd: '/owned/workspace', configuredModel: currentRow.provider === 'claude' ? 'haiku' : null, configuredEffort: currentRow.provider === 'claude' ? 'low' : null, launch: { incarnationId: `inc-${index}`, launchNonce: `launch-${index}`, executionGeneration: index + 1, evidenceRevision: index } },
        sdk: currentRow.provider === 'claude' ? { version: '0.3.237', declaredNativeVersion: '2.1.237', selection: 'sidecar-selected-module-resolution', packageSource, moduleSource, entrySource, moduleSha256: moduleSource.sha256, entrySha256: entrySource.sha256 } : null })
      const accepted = original(`${prefix}/accepted.json`, { source: 'registry-current-incarnation', soulId: currentRow.soulId, incarnationId: `inc-${index}`, containerId: `container-${index}`, hostBootId: `boot-${index}`, launchNonce: `launch-${index}`, executionGeneration: index + 1, providerStoreId: currentRow.providerStoreId, nativeSessionId,
        spec: { sessionType: currentRow.mode, provider: currentRow.mode === 'kilroy' ? 'kilroy' : currentRow.provider, runtimeVariant: currentRow.runtimeVariant, providerStoreId: currentRow.providerStoreId, nativeSessionId, cwd: '/owned/workspace', model: currentRow.model, effort: currentRow.effort === 'provider-default' ? null : currentRow.effort } })
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

describe('fresh-agent release scope truth', () => {
  it('admits the three requested fresh adapters for qualification while live release remains deferred', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../docs/development/runtime-provider-capabilities.json'),
      'utf8',
    ))
    for (const mode of ['freshclaude', 'freshcodex', 'freshopencode']) {
      const candidate = manifest.freshAgentModes.find((entry: { mode: string }) => entry.mode === mode)
      expect(candidate?.qualificationReady).toBe(true)
      expect(candidate?.certified).toBe(false)
      expect(candidate?.enabledInReleaseScope).toBe(false)
      expect(candidate?.releaseDeferralReason).toBe('pending_live_provider_certification')
      const doorway = manifest.doorways.find((entry: { id: string }) => entry.id === `rest-${mode}-create`)
      expect(doorway?.identityRule).toBe('PENDING_LIVE_PROVIDER_CERTIFICATION')
    }
  })
  it('records host-owned implementation without promoting any fresh mode', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../docs/development/runtime-provider-capabilities.json'),
      'utf8',
    ))
    expect(manifest.schemaVersion).toBeGreaterThanOrEqual(2)
    expect(manifest.freshAgentModes.map((candidate: any) => candidate.mode)).toEqual([
      'freshclaude', 'kilroy', 'freshcodex', 'freshopencode',
    ])
    expect(manifest.freshAgentModes.every((candidate: any) => (
      candidate.hostOwnedImplementation === true
      && candidate.enabledInReleaseScope === false
      && candidate.liveQualificationStatus === 'pending_authentic_receipt'
      && candidate.certified === false
    ))).toBe(true)
    expect(releasedFreshAgentModes(manifest)).toEqual([])
    expect(freshAgentReleaseScopeViolations(manifest, [])).toEqual([])
  })

  it('fails if host-owned code is released without live certification', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../docs/development/runtime-provider-capabilities.json'),
      'utf8',
    ))
    manifest.freshAgentModes[0].enabledInReleaseScope = true
    expect(freshAgentReleaseScopeViolations(manifest, []).join(' ')).toMatch(/freshclaude.*live|receipt|certif/i)
  })

  it('rejects a disabled fresh adapter without an explicit live deferral', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../docs/development/runtime-provider-capabilities.json'),
      'utf8',
    ))
    manifest.freshAgentModes[0].releaseDeferralReason = 'missing_mcp'
    expect(freshAgentReleaseScopeViolations(manifest, []).join(' ')).toMatch(/freshclaude.*live.*deferral/i)
  })

  it('keeps the global fresh-agent flag equal to the per-mode release scope', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../docs/development/runtime-provider-capabilities.json'),
      'utf8',
    ))
    manifest.releaseScope.freshAgentEnabled = true
    expect(freshAgentReleaseScopeViolations(manifest, []).join(' ')).toMatch(/freshAgentEnabled/i)
  })

  it('fails if a disabled fresh mode is accidentally counted as PASS', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../docs/development/runtime-provider-capabilities.json'),
      'utf8',
    ))
    expect(freshAgentReleaseScopeViolations(manifest, ['freshcodex']).join(' '))
      .toMatch(/freshcodex.*disabled.*PASS/i)
  })

  it('requires the release disabled-mode list to match fresh mode rows exactly', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../docs/development/runtime-provider-capabilities.json'),
      'utf8',
    ))
    manifest.releaseScope.disabledFreshAgentModes.pop()
    expect(freshAgentReleaseScopeViolations(manifest, []).join(' ')).toMatch(/disabledFreshAgentModes/i)
  })

  it('requires no receipt while all modes remain disabled and rejects a disabled PASS row', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../../docs/development/runtime-provider-capabilities.json'),
      'utf8',
    ))
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
    }).rows).toEqual([row()])
  })

  it('never accepts a deterministic fixture build as live-provider evidence', () => {
    expect(() => fixture([row()], 'deterministic_fixture')).toThrow(/fixtures cannot satisfy/i)
  })

  it.each(['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'] as const)(
    'accepts a truthful independent %s row',
    (mode) => expect(fixture([row(mode)]).receipt.selectedModes).toEqual([mode]),
  )

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
