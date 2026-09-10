import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CHAOS_MAX_CYCLE_GAP_MS,
  PHASE5_CHAOS_ASSERTIONS_FILE,
  PHASE5_CHAOS_PROVIDER_EVENTS_FILE,
  phase5ChaosRetainedBundle,
  validatePhase5ChaosReceipt,
} from '../../../../scripts/testing/runtime-phase5-chaos-evidence.js'

const sha = 'a'.repeat(40)
const image = `sha256:${'b'.repeat(64)}`
const runId = 'chaos-run-1234'
const soulId = 'soul-chaos'
const incarnationId = 'incarnation-chaos'
const containerId = 'c'.repeat(64)
const hostBootId = 'host-boot-chaos'
const nativeSessionId = 'ses_exact_chaos'
const roots: string[] = []

function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function runtimeObservation() {
  return {
    soulId,
    incarnationId,
    containerId,
    hostBootId,
    nativeSessionId,
    providerPid: 700,
    providerLaunchCount: 1,
    activeWriters: 1,
    unsafeBrokerAttempts: 0,
    limits: { cpuMax: '200000 100000', memoryMax: '4294967296', swapMax: '0', pidsMax: '512' },
  }
}

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-chaos-receipt-'))
  roots.push(repoRoot)
  const evidenceDir = path.join(repoRoot, '.runtime-evidence', sha, runId)
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  const capabilities = {
    schemaVersion: 1,
    providers: [{ provider: 'opencode', managedEnabled: true, durableRecoveryEnabled: true, recoveryPaths: ['reattach', 'native_resume'] }],
  }
  fs.mkdirSync(path.join(repoRoot, 'docs/development'), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, 'docs/development/runtime-provider-capabilities.json'), JSON.stringify(capabilities))
  fs.mkdirSync(path.join(repoRoot, 'test/runtime'), { recursive: true })
  const gateManifest = { schema_version: 1, kind: 'test-runtime-gate-manifest' }
  fs.writeFileSync(path.join(repoRoot, 'test/runtime/gate-manifest.json'), JSON.stringify(gateManifest))
  let clock = 1_000
  let priorWebPid = 100
  let priorWebBootId = 'web-boot-0'
  const webCycles = Array.from({ length: 100 }, (_, index) => {
    const cycle = index + 1
    const startedMonotonicMs = clock
    const endedMonotonicMs = startedMonotonicMs + 10
    clock = endedMonotonicMs + 5
    const afterPid = priorWebPid + 1
    const afterBootId = `web-boot-${cycle}`
    const row = {
      cycle,
      mode: cycle % 2 === 1 ? 'abrupt' : 'graceful',
      attemptCount: 1,
      startedMonotonicMs,
      endedMonotonicMs,
      beforePid: priorWebPid,
      afterPid,
      beforeBootId: priorWebBootId,
      afterBootId,
      runtime: runtimeObservation(),
    }
    priorWebPid = afterPid
    priorWebBootId = afterBootId
    return row
  })
  let priorSupervisorContainerId = 'd'.repeat(64)
  let priorSupervisorPid = 1_000
  let controlEpoch = 20
  const supervisorCycles = Array.from({ length: 20 }, (_, index) => {
    const cycle = index + 1
    const startedMonotonicMs = clock
    const endedMonotonicMs = startedMonotonicMs + 20
    clock = endedMonotonicMs + 5
    const afterContainerId = (cycle.toString(16).padStart(2, '0')).repeat(32)
    const row = {
      cycle,
      mode: cycle % 2 === 1 ? 'abrupt' : 'graceful',
      attemptCount: 1,
      startedMonotonicMs,
      endedMonotonicMs,
      beforeContainerId: priorSupervisorContainerId,
      afterContainerId,
      beforePid: priorSupervisorPid,
      afterPid: priorSupervisorPid + 1,
      beforeControlEpoch: controlEpoch,
      afterControlEpoch: controlEpoch + 1,
      runtime: runtimeObservation(),
    }
    priorSupervisorContainerId = afterContainerId
    priorSupervisorPid += 1
    controlEpoch += 1
    return row
  })
  const assertions = {
    schemaVersion: 1,
    caseId: 'P5-G09',
    candidateSha: sha,
    receiptRunId: runId,
    test: { total: 1, passed: 1, failed: 0, skipped: 0 },
    identity: {
      provider: 'opencode', providerVersion: '1.18.21', model: 'opencode/big-pickle',
      paneId: 'pane-chaos', terminalId: 'terminal-chaos', ...runtimeObservation(),
    },
    webCycles,
    supervisorCycles,
    approval: { toolRequestId: 'tool-approval', decisionsBeforeClick: 0, decisionsAfterClick: 1, markerCount: 1 },
    longTool: { toolRequestId: 'tool-long', markerCount: 1, sleepSeconds: 180 },
    falseLossQuery: {
      profileId: 'profile:phase5-chaos', soulId, evidenceRevision: 7, matchingNoticeIds: [],
    },
    followUp: { nativeMessageId: 'message-followup', completed: true },
  }
  const providerEvents = {
    schemaVersion: 1,
    provider: 'opencode',
    nativeSessionId,
    approval: { requestIds: ['tool-approval'], resultIds: ['tool-approval'], providerDecisionCount: 1, replayCount: 0 },
    longTool: { requestIds: ['tool-long'], resultIds: ['tool-long'], replayCount: 0 },
    followUp: { messageIds: ['message-followup'], completedCount: 1 },
  }
  const files: Record<string, unknown | string> = {
    'manifest.json': { ...gateManifest, execution: { candidateSha: sha, runId, startedAt: '2026-09-09T19:59:59.000Z' } },
    'build.json': {
      candidateSha: sha,
      runtimeImage: image,
      rustc: 'rustc 1.96.1',
      node: 'v22.0.0',
      docker: 'client=1 server=1',
      binaries: Object.fromEntries([
        'testSupervisor', 'testHost', 'releaseSupervisor', 'releaseHost',
      ].map((name) => [name, { path: `/tmp/runtime-build/${name}`, sha256: '8'.repeat(64), bytes: 1 }])),
    },
    'cleanup.json': {
      ok: true,
      errors: [],
      exactContainerIds: [containerId],
      volumes: [],
      unsafeBrokerAttempts: [],
      completedAt: '2026-09-09T20:00:01.000Z',
    },
    'broker.jsonl': `${JSON.stringify({
      at: '2026-09-09T20:00:00.003Z', method: 'GET', url: `/v1.47/containers/${containerId}/json`,
      decision: 'forward', unsafeAttempt: false, destructive: false, containerId,
    })}\n`,
    'lifecycle.jsonl': `${JSON.stringify({ sequence: 1, monotonicMs: 1, event: 'chaos.started' })}\n`,
    [PHASE5_CHAOS_ASSERTIONS_FILE]: assertions,
    [PHASE5_CHAOS_PROVIDER_EVENTS_FILE]: providerEvents,
    'phase5-chaos-server-log.jsonl': `${JSON.stringify({
      source: 'server', sequence: 1, monotonicMs: 1, level: 'info', event: 'captured-output',
      contentSha256: hash('server output'), contentBytes: 13, redacted: true,
    })}\n`,
    'phase5-chaos-browser-log.jsonl': `${JSON.stringify({
      source: 'browser', sequence: 1, monotonicMs: 1, level: 'info', event: 'console',
      contentSha256: hash('browser output'), contentBytes: 14, redacted: true,
    })}\n`,
    'phase5-capability-inventory.json': capabilities,
  }
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(evidenceDir, name), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
  }
  const artifact = (name: string) => ({ path: `.runtime-evidence/${sha}/${runId}/${name}`, sha256: hash(fs.readFileSync(path.join(evidenceDir, name))) })
  const integrity = { sha, dirty: false, diffHash: hash(''), statusHash: hash('') }
  const receipt = {
    schemaVersion: 2,
    kind: 'phase5_chaos',
    status: 'PASS',
    candidateSha: sha,
    runtimeImage: image,
    receiptRunId: runId,
    evidenceRun: `.runtime-evidence/${sha}/${runId}`,
    candidateIntegrity: { before: integrity, after: integrity, failures: [] },
    artifacts: {
      assertions: artifact(PHASE5_CHAOS_ASSERTIONS_FILE),
      providerEvents: artifact(PHASE5_CHAOS_PROVIDER_EVENTS_FILE),
      lifecycle: artifact('lifecycle.jsonl'),
      broker: artifact('broker.jsonl'),
      cleanup: artifact('cleanup.json'),
      build: artifact('build.json'),
      manifest: artifact('manifest.json'),
      capabilityInventory: artifact('phase5-capability-inventory.json'),
      serverLog: artifact('phase5-chaos-server-log.jsonl'),
      browserLog: artifact('phase5-chaos-browser-log.jsonl'),
    },
    summary: {
      provider: 'opencode', soulId, incarnationId, nativeSessionId,
      webReplacementCycles: 100, supervisorReplacementCycles: 20,
      approvalDecisionCount: 1, providerToolRequestCount: 2, providerToolResultCount: 2,
      replayCount: 0, falseLossNoticeCount: 0, unsafeBrokerAttempts: 0,
      maxCycleGapMs: 5, serverLogBytes: Buffer.byteLength(files['phase5-chaos-server-log.jsonl'] as string),
      browserLogBytes: Buffer.byteLength(files['phase5-chaos-browser-log.jsonl'] as string),
    },
  }
  const rewrite = (name: string, mutate: (value: any) => void) => {
    const target = path.join(evidenceDir, name)
    const value = JSON.parse(fs.readFileSync(target, 'utf8'))
    mutate(value)
    fs.writeFileSync(target, JSON.stringify(value), { mode: 0o600 })
  }
  const rehash = (name: string) => {
    const ref = Object.values(receipt.artifacts).find((row: any) => row.path.endsWith(`/${name}`)) as any
    ref.sha256 = hash(fs.readFileSync(path.join(evidenceDir, name)))
  }
  return { repoRoot, evidenceDir, receipt, rewrite, rehash }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function validate(fx: ReturnType<typeof fixture>) {
  return validatePhase5ChaosReceipt({ repoRoot: fx.repoRoot, candidateSha: sha, runtimeImage: image, receipt: fx.receipt })
}

describe('Phase 5 chaos receipt validation', () => {
  it('derives PASS from all 100/20 exact cycle rows and hashed provider/native evidence', () => {
    const fx = fixture()
    const validated = validate(fx)
    expect(validated.summary).toEqual(fx.receipt.summary)
    expect(Object.keys(phase5ChaosRetainedBundle(validated).files)).toHaveLength(10)
  })

  it('rejects schema v1, unknown fields, skipped tests, and summary self-assertions', () => {
    for (const mutate of [
      (fx: ReturnType<typeof fixture>) => { fx.receipt.schemaVersion = 1 },
      (fx: ReturnType<typeof fixture>) => { fx.receipt.duplicateWriters = 0 },
      (fx: ReturnType<typeof fixture>) => {
        fx.receipt.candidateIntegrity.before.statusHash = '1'.repeat(64)
        fx.receipt.candidateIntegrity.after.statusHash = '1'.repeat(64)
      },
      (fx: ReturnType<typeof fixture>) => { fx.rewrite(PHASE5_CHAOS_ASSERTIONS_FILE, (row) => { row.test.skipped = 1 }); fx.rehash(PHASE5_CHAOS_ASSERTIONS_FILE) },
      (fx: ReturnType<typeof fixture>) => { fx.receipt.summary.replayCount = 1 },
    ]) {
      const fx = fixture(); mutate(fx); expect(() => validate(fx)).toThrow()
    }
  })

  it('requires every exact cycle with declared alternation and no retry masking', () => {
    for (const mutation of [
      (row: any) => { row.webCycles.pop() },
      (row: any) => { row.supervisorCycles[4].cycle = 4 },
      (row: any) => { row.webCycles[2].mode = 'graceful' },
      (row: any) => { row.supervisorCycles[1].attemptCount = 2 },
    ]) {
      const fx = fixture(); fx.rewrite(PHASE5_CHAOS_ASSERTIONS_FILE, mutation); fx.rehash(PHASE5_CHAOS_ASSERTIONS_FILE)
      expect(() => validate(fx)).toThrow(/cycle|alternat|attempt/i)
    }
  })

  it('requires unique replacement process/container identities and continuous chains', () => {
    for (const mutation of [
      (row: any) => { row.webCycles[1].afterPid = row.webCycles[0].afterPid },
      (row: any) => { row.webCycles[2].beforePid = 99999 },
      (row: any) => { row.webCycles[1].afterBootId = row.webCycles[0].afterBootId },
      (row: any) => { row.webCycles[2].beforeBootId = 'wrong-boot-chain' },
      (row: any) => { row.supervisorCycles[3].afterContainerId = row.supervisorCycles[2].afterContainerId },
      (row: any) => { row.supervisorCycles[4].beforeControlEpoch -= 1 },
    ]) {
      const fx = fixture(); fx.rewrite(PHASE5_CHAOS_ASSERTIONS_FILE, mutation); fx.rehash(PHASE5_CHAOS_ASSERTIONS_FILE)
      expect(() => validate(fx)).toThrow(/identity|chain|epoch|unique/i)
    }
  })

  it('requires monotonic bounded cycles', () => {
    for (const mutation of [
      (row: any) => { row.webCycles[1].startedMonotonicMs = row.webCycles[0].startedMonotonicMs },
      (row: any) => { row.webCycles[1].endedMonotonicMs = row.webCycles[1].startedMonotonicMs - 1 },
      (row: any) => { row.supervisorCycles[0].startedMonotonicMs += CHAOS_MAX_CYCLE_GAP_MS + 1 },
    ]) {
      const fx = fixture(); fx.rewrite(PHASE5_CHAOS_ASSERTIONS_FILE, mutation); fx.rehash(PHASE5_CHAOS_ASSERTIONS_FILE)
      expect(() => validate(fx)).toThrow(/monotonic|gap|window/i)
    }
  })

  it('requires the same soul/native/incarnation/host/writer and effective limits throughout', () => {
    for (const mutation of [
      (row: any) => { row.webCycles[50].runtime.incarnationId = 'replacement' },
      (row: any) => { row.supervisorCycles[10].runtime.activeWriters = 2 },
      (row: any) => { row.webCycles[4].runtime.unsafeBrokerAttempts = 1 },
      (row: any) => { row.supervisorCycles[3].runtime.limits.swapMax = 'max' },
    ]) {
      const fx = fixture(); fx.rewrite(PHASE5_CHAOS_ASSERTIONS_FILE, mutation); fx.rehash(PHASE5_CHAOS_ASSERTIONS_FILE)
      expect(() => validate(fx)).toThrow(/runtime|writer|unsafe|limit|swap/i)
    }
  })

  it('requires zero decisions before click and exactly one provider-side decision after click', () => {
    for (const mutation of [
      (row: any) => { row.approval.decisionsBeforeClick = 1 },
      (row: any) => { row.approval.decisionsAfterClick = 2 },
      (row: any) => { row.approval.markerCount = 2 },
    ]) {
      const fx = fixture(); fx.rewrite(PHASE5_CHAOS_ASSERTIONS_FILE, mutation); fx.rehash(PHASE5_CHAOS_ASSERTIONS_FILE)
      expect(() => validate(fx)).toThrow(/approval|decision|marker/i)
    }
  })

  it('requires one native request/result per tool, no replay, and exact follow-up evidence', () => {
    for (const mutation of [
      (row: any) => { row.approval.requestIds.push('tool-extra') },
      (row: any) => { row.longTool.resultIds = [] },
      (row: any) => { row.longTool.replayCount = 1 },
      (row: any) => { row.followUp.completedCount = 0 },
    ]) {
      const fx = fixture(); fx.rewrite(PHASE5_CHAOS_PROVIDER_EVENTS_FILE, mutation); fx.rehash(PHASE5_CHAOS_PROVIDER_EVENTS_FILE)
      expect(() => validate(fx)).toThrow(/provider|tool|replay|follow-up/i)
    }
  })

  it('binds false-loss notice evidence to the exact profile, soul, and durable revision', () => {
    for (const mutation of [
      (row: any) => { row.falseLossQuery.profileId = 'profile:other' },
      (row: any) => { row.falseLossQuery.soulId = 'soul-other' },
      (row: any) => { row.falseLossQuery.evidenceRevision = 0 },
      (row: any) => { row.falseLossQuery.matchingNoticeIds = ['notice-loss'] },
    ]) {
      const fx = fixture(); fx.rewrite(PHASE5_CHAOS_ASSERTIONS_FILE, mutation); fx.rehash(PHASE5_CHAOS_ASSERTIONS_FILE)
      expect(() => validate(fx)).toThrow(/profile|soul|revision|notice/i)
    }
  })

  it('retains bounded server/browser logs and rejects secrets or response content', () => {
    const missing = fixture(); fs.unlinkSync(path.join(missing.evidenceDir, 'phase5-chaos-browser-log.jsonl'))
    expect(() => validate(missing)).toThrow(/missing/i)

    const secret = fixture()
    fs.appendFileSync(path.join(secret.evidenceDir, 'phase5-chaos-server-log.jsonl'), `${JSON.stringify({ error: 'Bearer abcdefghijklmnop' })}\n`)
    secret.rehash('phase5-chaos-server-log.jsonl')
    expect(() => validate(secret)).toThrow(/secret|redact/i)

    const response = fixture()
    response.rewrite(PHASE5_CHAOS_PROVIDER_EVENTS_FILE, (row) => { row.providerResponse = 'synthetic native transcript text' })
    response.rehash(PHASE5_CHAOS_PROVIDER_EVENTS_FILE)
    expect(() => validate(response)).toThrow(/unknown field/i)

    for (const mutate of [
      (row: any) => { row.redacted = false },
      (row: any) => { row.sequence = 2 },
      (row: any) => { row.contentSha256 = 'raw provider response' },
    ]) {
      const malformed = fixture()
      const target = path.join(malformed.evidenceDir, 'phase5-chaos-server-log.jsonl')
      const row = JSON.parse(fs.readFileSync(target, 'utf8'))
      mutate(row)
      fs.writeFileSync(target, `${JSON.stringify(row)}\n`, { mode: 0o600 })
      malformed.rehash('phase5-chaos-server-log.jsonl')
      expect(() => validate(malformed)).toThrow(/log|redact|sequence|digest/i)
    }
  })
})
