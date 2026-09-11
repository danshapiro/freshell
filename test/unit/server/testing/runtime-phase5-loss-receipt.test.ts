import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  PHASE5_LOSS_ASSERTIONS_FILE,
  PHASE5_LOSS_INCIDENT_FILE,
  assertPhase5LossRun,
} from '../../../../scripts/testing/runtime-phase5-loss-evidence.js'

const sha = 'a'.repeat(40)
const runtimeImage = `sha256:${'b'.repeat(64)}`
const runId = 'loss-run-1234'
const incidentId = 'incident-11111111-1111-4111-8111-111111111111'
const soulId = 'soul-11111111-1111-4111-8111-111111111111'
const incarnationId = 'incarnation-11111111-1111-4111-8111-111111111111'
const nativeHash = `sha256:${'c'.repeat(64)}`
const roots: string[] = []

function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function createFixture(): {
  repoRoot: string
  evidenceDir: string
  rewrite(name: string, mutate: (value: any) => void): void
} {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-loss-receipt-'))
  roots.push(repoRoot)
  const evidenceDir = path.join(repoRoot, '.runtime-evidence', sha, runId)
  fs.mkdirSync(path.join(evidenceDir, 'browser'), { recursive: true, mode: 0o700 })
  const capabilities = {
    schemaVersion: 1,
    providers: [{
      provider: 'opencode',
      managedEnabled: true,
      durableRecoveryEnabled: true,
      stateStore: '$XDG_DATA_HOME/opencode/opencode.db',
      recoveryPaths: ['reattach', 'native_resume', 'checkpoint_restore', 'pristine_seed'],
    }],
  }
  fs.mkdirSync(path.join(repoRoot, 'docs/development'), { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'test/runtime'), { recursive: true })
  const gateManifest = { schema_version: 1, kind: 'test-runtime-gate-manifest' }
  fs.writeFileSync(
    path.join(repoRoot, 'test/runtime/gate-manifest.json'),
    JSON.stringify(gateManifest),
  )
  fs.writeFileSync(
    path.join(repoRoot, 'docs/development/runtime-provider-capabilities.json'),
    JSON.stringify(capabilities),
  )
  const certificate = {
    schemaVersion: 1,
    event: 'soul.loss.finalized',
    incidentId,
    correlationId: 'correlation-11111111-1111-4111-8111-111111111111',
    installationId: 'installation-11111111-1111-4111-8111-111111111111',
    soulId,
    provider: 'opencode',
    providerStoreId: 'store-phase5',
    nativeSessionRefHash: nativeHash,
    intentRevision: 7,
    incarnations: [incarnationId],
    builds: {
      webCommit: sha,
      supervisorCommit: sha,
      hostImageDigest: runtimeImage,
      providerVersion: '1.18.21',
      protocolVersion: 1,
      registrySchemaVersion: 1,
    },
    timeline: [
      { seq: 1, at: '2026-09-09T20:00:00.000Z', event: 'recovery_trigger', evidenceRef: 'registry://exact' },
      { seq: 2, at: '2026-09-09T20:00:00.001Z', event: 'all_paths_negative', evidenceRef: 'capability-manifest://sha256' },
    ],
    recoveryPaths: capabilities.providers[0].recoveryPaths.map((recoveryPath) => {
      const storeState = recoveryPath === 'reattach' || recoveryPath === 'pristine_seed'
        ? 'not_applicable'
        : 'missing'
      return {
      path: recoveryPath,
      verdict: 'definitive_negative',
      reasonCode: `${recoveryPath}_definitive_negative_${storeState}`,
      evidenceRefs: [
        `recoveryPath=${recoveryPath}`,
        `storeState=${storeState}`,
        `transientEvidenceDigest=sha256:${'9'.repeat(64)}`,
      ],
      storeState,
    }
    }),
    decision: {
      state: 'lost',
      reasonCode: 'all_applicable_recovery_paths_definitively_unavailable',
      unknownPaths: 0,
      retainedRecoverableEvidence: false,
    },
    cleanupTarget: {
      ownedHandleRef: `registry://installation/installation/soul/${soulId}/incarnation/${incarnationId}`,
      ownershipVerified: true,
      incarnationId,
    },
    analysis: {
      observedCause: 'all_applicable_recovery_paths_definitively_unavailable',
      missingInvariant: 'no live enclosure, readable native store, verified checkpoint, or pristine never-dispatched seed remained',
      hypotheses: [
        'provider state was removed or became irreversibly inconsistent',
        'the runtime exited after its last durable recovery artifact disappeared',
      ],
      preventiveAction: 'retain and continuously verify at least one independent native-store or checkpoint recovery artifact',
      regressionCase: 'P5-G02',
    },
    createdAt: '2026-09-09T20:00:00.000Z',
  }
  const certificateSha256 = digest(JSON.stringify(certificate))
  const incident = {
    incidentId,
    event: 'soul.loss.finalized',
    certificate,
    certificateSha256,
    cleanupState: 'closed',
    cleanup: {
      ownedHandleRef: certificate.cleanupTarget.ownedHandleRef,
      ownershipVerified: true,
      gracefulAttempt: 'authenticated_host_and_exact_backend_stop_requested',
      forcedAttempt: 'attempted_only_if_graceful_verification_required_escalation',
      verifiedEmpty: true,
      verifiedAt: '2026-09-09T20:00:00.010Z',
      foreignObjectsTouched: 0,
    },
    noticeId: 'notice-11111111-1111-4111-8111-111111111111',
    updatedAt: '2026-09-09T20:00:00.010Z',
  }
  const assertions = {
    schemaVersion: 1,
    caseId: 'P5-G02',
    candidateSha: sha,
    receiptRunId: runId,
    test: { total: 1, passed: 1, failed: 0, skipped: 0 },
    identity: {
      provider: 'opencode',
      providerVersion: '1.18.21',
      model: 'opencode/big-pickle',
      soulId,
      incarnationId,
      containerId: 'd'.repeat(64),
      hostBootId: 'host-11111111-1111-4111-8111-111111111111',
      nativeSessionIdHash: nativeHash,
      incidentId,
      paneId: 'pane-phase5',
      terminalId: 'terminal-phase5',
    },
    intent: { checkedRevision: 7, lossRevision: 7, endedRevision: 8 },
    providerState: {
      exactAbsenceChecks: [
        { path: '/home/freshell/provider/.local/share/opencode/opencode.db', state: 'absent', probe: 'lstat' },
        { path: '/home/freshell/provider/.freshell/checkpoints', state: 'absent', probe: 'lstat' },
      ],
      credentialIntegrity: [{
        path: '/home/freshell/provider/.local/share/opencode/auth.json',
        beforeExists: true,
        afterExists: true,
        beforeSha256: 'e'.repeat(64),
        afterSha256: 'e'.repeat(64),
      }],
    },
    browser: {
      displayedNoticeIds: [incident.noticeId],
      endedPane: {
        soulId,
        incarnationId,
        incidentId,
        nativeSessionIdHash: nativeHash,
        recoveryState: 'lost',
      },
    },
  }
  const lifecycle = [
    {
      at: '2026-09-09T20:00:00.002Z',
      event: 'supervisor.lifecycle',
      data: { raw: {
        sequence: 40, monotonicNanos: 100, processId: 42,
        event: 'supervisor.loss.incident_committed',
        data: { incidentId, soulId, certificateSha256 },
      } },
    },
    {
      at: '2026-09-09T20:00:00.011Z',
      event: 'supervisor.lifecycle',
      data: { raw: {
        sequence: 41, monotonicNanos: 200, processId: 42,
        event: 'supervisor.loss.finalized',
        data: { incidentId, soulId, certificateSha256, cleanupOutcome: 'verified_empty' },
      } },
    },
  ]
  const files: Record<string, unknown | string> = {
    'manifest.json': { ...gateManifest,
      execution: { candidateSha: sha, runId, startedAt: '2026-09-09T19:59:59.000Z' },
    },
    'build.json': {
      candidateSha: sha,
      runtimeImage,
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
      exactContainerIds: ['d'.repeat(64)],
      volumes: [],
      unsafeBrokerAttempts: [],
      completedAt: '2026-09-09T20:00:01.000Z',
    },
    'broker.jsonl': `${JSON.stringify({
      at: '2026-09-09T20:00:00.003Z', method: 'POST', url: `/v1.47/containers/${'d'.repeat(64)}/stop`,
      decision: 'forward', unsafeAttempt: false, destructive: true, containerId: 'd'.repeat(64),
    })}\n`,
    'lifecycle.jsonl': lifecycle.map((row) => JSON.stringify(row)).join('\n') + '\n',
    [PHASE5_LOSS_ASSERTIONS_FILE]: assertions,
    [PHASE5_LOSS_INCIDENT_FILE]: incident,
    'phase5-capability-inventory.json': capabilities,
  }
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(evidenceDir, name),
      typeof value === 'string' ? value : JSON.stringify(value),
      { mode: 0o600 },
    )
  }
  return { repoRoot, evidenceDir,
    rewrite(name, mutate) {
      const target = path.join(evidenceDir, name)
      const value = JSON.parse(fs.readFileSync(target, 'utf8')); mutate(value)
      if (name === PHASE5_LOSS_INCIDENT_FILE) {
        value.certificateSha256 = digest(JSON.stringify(value.certificate))
        const log = path.join(evidenceDir, 'lifecycle.jsonl')
        const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        for (const row of rows) row.data.raw.data.certificateSha256 = value.certificateSha256
        fs.writeFileSync(log, rows.map(row => JSON.stringify(row)).join('\n')+'\n')
      }
      fs.writeFileSync(target, JSON.stringify(value))
    },
  }
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
describe('direct loss observations', () => {
  it('checks persisted loss, lifecycle ordering, cleanup, and browser identity directly', () => {
    const fx = createFixture()
    expect(assertPhase5LossRun(fx.evidenceDir).summary).toMatchObject({ exactCleanupVerified: true, displayedNoticeCount: 1, foreignObjectsTouched: 0 })
  })


  it.each([
    ['missing cleanup', 'cleanup.json'],
    ['missing incident', PHASE5_LOSS_INCIDENT_FILE],
    ['missing lifecycle', 'lifecycle.jsonl'],
  ])('rejects %s evidence', (_label, name) => {
    const fx = createFixture()
    fs.unlinkSync(path.join(fx.evidenceDir, name))
    expect(() => assertPhase5LossRun(fx.evidenceDir)).toThrow(/missing|read/i)
  })


  it('requires exact current intent, definitive inventory-complete negatives, and positive absence checks', () => {
    for (const [file, mutation] of [
      [PHASE5_LOSS_ASSERTIONS_FILE, (row: any) => { row.intent.checkedRevision = 6 }],
      [PHASE5_LOSS_ASSERTIONS_FILE, (row: any) => { row.providerState.exactAbsenceChecks[0].state = 'unknown' }],
      [PHASE5_LOSS_INCIDENT_FILE, (row: any) => { row.certificate.recoveryPaths.pop() }],
      [PHASE5_LOSS_INCIDENT_FILE, (row: any) => { row.certificate.recoveryPaths[0].verdict = 'blocked' }],
    ] as const) {
      const fx = createFixture()
      fx.rewrite(file, mutation)
      expect(() => assertPhase5LossRun(fx.evidenceDir)).toThrow()
    }
  })


  it('requires monotonic lifecycle ordering bound to the durable certificate hash', () => {
    for (const mutation of [
      (rows: any[]) => { rows[1].data.raw.sequence = 39 },
      (rows: any[]) => { rows[1].data.raw.monotonicNanos = 99 },
      (rows: any[]) => { rows[0].data.raw.data.certificateSha256 = '1'.repeat(64) },
    ]) {
      const fx = createFixture()
      const target = path.join(fx.evidenceDir, 'lifecycle.jsonl')
      const rows = fs.readFileSync(target, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      mutation(rows)
      fs.writeFileSync(target, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
      expect(() => assertPhase5LossRun(fx.evidenceDir)).toThrow(/lifecycle|certificate hash|ordering/i)
    }
  })


  it('requires exact ownership, zero foreign touches, immutable credentials, and exact ended-pane identity', () => {
    for (const [file, mutation] of [
      [PHASE5_LOSS_INCIDENT_FILE, (row: any) => { row.cleanup.foreignObjectsTouched = 1 }],
      [PHASE5_LOSS_INCIDENT_FILE, (row: any) => { row.cleanup.ownedHandleRef = 'registry://wrong' }],
      [PHASE5_LOSS_ASSERTIONS_FILE, (row: any) => { row.providerState.credentialIntegrity[0].afterSha256 = '1'.repeat(64) }],
      [PHASE5_LOSS_ASSERTIONS_FILE, (row: any) => { row.browser.endedPane.incarnationId = 'incarnation-wrong' }],
    ] as const) {
      const fx = createFixture()
      fx.rewrite(file, mutation)
      expect(() => assertPhase5LossRun(fx.evidenceDir)).toThrow()
    }
  })


  it('rejects secret-looking values and provider transcript/response fields from receipt paths', () => {
    for (const [file, mutation] of [
      [PHASE5_LOSS_ASSERTIONS_FILE, (row: any) => { row.providerResponse = 'synthetic native transcript content' }],
      [PHASE5_LOSS_INCIDENT_FILE, (row: any) => { row.certificate.analysis.observedCause = 'Bearer abcdefghijklmnop' }],
      [PHASE5_LOSS_INCIDENT_FILE, (row: any) => {
        row.certificate.analysis.observedCause = 'synthetic native transcript text'
        row.certificateSha256 = digest(JSON.stringify(row.certificate))
      }],
      ['cleanup.json', (row: any) => { row.errors = ['sk-abcdefghijklmnop'] }],
    ] as const) {
      const fx = createFixture()
      fx.rewrite(file, mutation)
      expect(() => assertPhase5LossRun(fx.evidenceDir)).toThrow(/secret|unknown field|redact|structured|analysis|observed loss cause/i)
    }
  })
  it('accepts absent postmortem enrichment without weakening loss checks', () => {
    const fx = createFixture()
    fx.rewrite(PHASE5_LOSS_INCIDENT_FILE, row => { row.certificate.analysis = { observedCause: 'all_applicable_recovery_paths_definitively_unavailable' } })
    expect(() => assertPhase5LossRun(fx.evidenceDir)).not.toThrow()
  })
  it('rejects unsuccessful cleanup, skipped tests, and foreign destructive targets', () => {
    for (const [name, mutate] of [
      ['cleanup.json', (row: any) => { row.ok = false }],
      [PHASE5_LOSS_ASSERTIONS_FILE, (row: any) => { row.test.skipped = 1 }],
      ['broker.jsonl', (row: any) => { row.containerId = '9'.repeat(64) }],
    ] as const) {
      const fx = createFixture(); fx.rewrite(name, mutate)
      expect(() => assertPhase5LossRun(fx.evidenceDir)).toThrow()
    }
  })
})
