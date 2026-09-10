import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  PHASE5_LOSS_ASSERTIONS_FILE,
  PHASE5_LOSS_INCIDENT_FILE,
  phase5LossRetainedBundle,
  validatePhase5LossReceipt,
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
  receipt: any
  rewrite(name: string, mutate: (value: any) => void): void
  rehash(name: string): void
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
  const artifact = (name: string) => ({
    path: `.runtime-evidence/${sha}/${runId}/${name}`,
    sha256: digest(fs.readFileSync(path.join(evidenceDir, name))),
  })
  const integrity = { sha, dirty: false, diffHash: digest(''), statusHash: digest('') }
  const receipt = {
    schemaVersion: 2,
    kind: 'phase5_loss',
    status: 'PASS',
    candidateSha: sha,
    runtimeImage,
    receiptRunId: runId,
    evidenceRun: `.runtime-evidence/${sha}/${runId}`,
    candidateIntegrity: { before: integrity, after: integrity, failures: [] },
    artifacts: {
      assertions: artifact(PHASE5_LOSS_ASSERTIONS_FILE),
      incident: artifact(PHASE5_LOSS_INCIDENT_FILE),
      lifecycle: artifact('lifecycle.jsonl'),
      broker: artifact('broker.jsonl'),
      cleanup: artifact('cleanup.json'),
      build: artifact('build.json'),
      manifest: artifact('manifest.json'),
      capabilityInventory: artifact('phase5-capability-inventory.json'),
    },
    summary: {
      provider: 'opencode', soulId, incarnationId, incidentId,
      exactCleanupVerified: true, displayedNoticeCount: 1, foreignObjectsTouched: 0,
    },
  }
  return {
    repoRoot,
    evidenceDir,
    receipt,
    rewrite(name, mutate) {
      const target = path.join(evidenceDir, name)
      const value = JSON.parse(fs.readFileSync(target, 'utf8'))
      mutate(value)
      fs.writeFileSync(target, JSON.stringify(value))
    },
    rehash(name) {
      const entry = Object.values(receipt.artifacts).find((row: any) => row.path.endsWith(`/${name}`)) as any
      entry.sha256 = digest(fs.readFileSync(path.join(evidenceDir, name)))
    },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Phase 5 loss receipt validation', () => {
  it('derives a PASS only from candidate-bound incident, lifecycle, cleanup, broker, and capability evidence', () => {
    const fx = createFixture()
    const validated = validatePhase5LossReceipt({
      repoRoot: fx.repoRoot, candidateSha: sha, runtimeImage, receipt: fx.receipt,
    })
    expect(validated.summary).toEqual(fx.receipt.summary)
    const retained = phase5LossRetainedBundle(validated)
    expect(Object.keys(retained.files).sort()).toEqual([
      'assertions.json', 'broker.jsonl', 'build.json', 'capability-inventory.json',
      'cleanup.json', 'incident.json', 'lifecycle.jsonl', 'manifest.json',
    ])
    expect(retained.index.sourceReceiptSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects schema v1 and unknown receipt fields', () => {
    const fx = createFixture()
    expect(() => validatePhase5LossReceipt({ ...fx, candidateSha: sha, runtimeImage, receipt: { ...fx.receipt, schemaVersion: 1 } })).toThrow(/schema v2/i)
    expect(() => validatePhase5LossReceipt({ ...fx, candidateSha: sha, runtimeImage, receipt: { ...fx.receipt, credentialsTouched: false } })).toThrow(/unknown field/i)
  })

  it.each([
    ['missing cleanup', 'cleanup.json'],
    ['missing incident', PHASE5_LOSS_INCIDENT_FILE],
    ['missing lifecycle', 'lifecycle.jsonl'],
  ])('rejects %s evidence', (_label, name) => {
    const fx = createFixture()
    fs.unlinkSync(path.join(fx.evidenceDir, name))
    expect(() => validatePhase5LossReceipt({ repoRoot: fx.repoRoot, candidateSha: sha, runtimeImage, receipt: fx.receipt })).toThrow(/missing|read/i)
  })

  it('rejects hash, candidate, image, cleanup, and broker mismatches', () => {
    for (const mutate of [
      (fx: ReturnType<typeof createFixture>) => { fx.receipt.artifacts.incident.sha256 = '0'.repeat(64) },
      (fx: ReturnType<typeof createFixture>) => { fx.receipt.candidateIntegrity.after.sha = '1'.repeat(40) },
      (fx: ReturnType<typeof createFixture>) => { fx.receipt.candidateIntegrity.before.diffHash = '1'.repeat(64); fx.receipt.candidateIntegrity.after.diffHash = '1'.repeat(64) },
      (fx: ReturnType<typeof createFixture>) => { fx.receipt.runtimeImage = `sha256:${'1'.repeat(64)}` },
      (fx: ReturnType<typeof createFixture>) => { fx.rewrite('cleanup.json', (row) => { row.ok = false; row.errors = ['cleanup failed'] }); fx.rehash('cleanup.json') },
      (fx: ReturnType<typeof createFixture>) => { fs.appendFileSync(path.join(fx.evidenceDir, 'broker.jsonl'), `${JSON.stringify({ unsafeAttempt: true })}\n`); fx.rehash('broker.jsonl') },
      (fx: ReturnType<typeof createFixture>) => {
        fs.appendFileSync(path.join(fx.evidenceDir, 'broker.jsonl'), `${JSON.stringify({
          at: '2026-09-09T20:00:00.004Z', method: 'POST', url: `/v1.47/containers/${'9'.repeat(64)}/stop`,
          decision: 'forward', unsafeAttempt: false, destructive: true, containerId: '9'.repeat(64),
        })}\n`)
        fx.rehash('broker.jsonl')
      },
    ]) {
      const fx = createFixture()
      mutate(fx)
      expect(() => validatePhase5LossReceipt({ repoRoot: fx.repoRoot, candidateSha: sha, runtimeImage, receipt: fx.receipt })).toThrow()
    }
  })

  it('rejects skipped/zero tests and self-declared summaries that differ from evidence', () => {
    for (const mutation of [
      (row: any) => { row.test.total = 0; row.test.passed = 0 },
      (row: any) => { row.test.skipped = 1 },
      (row: any) => { row.browser.displayedNoticeIds = [] },
    ]) {
      const fx = createFixture()
      fx.rewrite(PHASE5_LOSS_ASSERTIONS_FILE, mutation)
      fx.rehash(PHASE5_LOSS_ASSERTIONS_FILE)
      expect(() => validatePhase5LossReceipt({ repoRoot: fx.repoRoot, candidateSha: sha, runtimeImage, receipt: fx.receipt })).toThrow()
    }
    const fx = createFixture()
    fx.receipt.summary.exactCleanupVerified = false
    expect(() => validatePhase5LossReceipt({ repoRoot: fx.repoRoot, candidateSha: sha, runtimeImage, receipt: fx.receipt })).toThrow(/summary/i)
  })

  it('rejects ambiguous manifest, build, cleanup, and broker artifact schemas', () => {
    for (const [file, mutation] of [
      ['manifest.json', (row: any) => { row.unchecked = true }],
      ['build.json', (row: any) => { row.binaries.releaseHost.bytes = 0 }],
      ['cleanup.json', (row: any) => { row.credentialsTouched = false }],
      ['broker.jsonl', (row: any) => { delete row.method }],
    ] as const) {
      const fx = createFixture()
      fx.rewrite(file, mutation)
      fx.rehash(file)
      expect(() => validatePhase5LossReceipt({ repoRoot: fx.repoRoot, candidateSha: sha, runtimeImage, receipt: fx.receipt })).toThrow()
    }
  })

  it('rejects stale or hard-linked evidence files from another run', () => {
    const stale = createFixture()
    const stalePath = path.join(stale.evidenceDir, PHASE5_LOSS_ASSERTIONS_FILE)
    fs.utimesSync(stalePath, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'))
    stale.rehash(PHASE5_LOSS_ASSERTIONS_FILE)
    expect(() => validatePhase5LossReceipt({ repoRoot: stale.repoRoot, candidateSha: sha, runtimeImage, receipt: stale.receipt })).toThrow(/fresh.*provenance/i)

    const linked = createFixture()
    const original = path.join(linked.evidenceDir, 'linked-source.json')
    fs.renameSync(path.join(linked.evidenceDir, PHASE5_LOSS_ASSERTIONS_FILE), original)
    fs.linkSync(original, path.join(linked.evidenceDir, PHASE5_LOSS_ASSERTIONS_FILE))
    expect(() => validatePhase5LossReceipt({ repoRoot: linked.repoRoot, candidateSha: sha, runtimeImage, receipt: linked.receipt })).toThrow(/hard-linked/i)
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
      fx.rehash(file)
      expect(() => validatePhase5LossReceipt({ repoRoot: fx.repoRoot, candidateSha: sha, runtimeImage, receipt: fx.receipt })).toThrow()
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
      fx.rehash('lifecycle.jsonl')
      expect(() => validatePhase5LossReceipt({ repoRoot: fx.repoRoot, candidateSha: sha, runtimeImage, receipt: fx.receipt })).toThrow(/lifecycle|certificate hash|ordering/i)
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
      fx.rehash(file)
      expect(() => validatePhase5LossReceipt({ repoRoot: fx.repoRoot, candidateSha: sha, runtimeImage, receipt: fx.receipt })).toThrow()
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
      fx.rehash(file)
      expect(() => validatePhase5LossReceipt({ repoRoot: fx.repoRoot, candidateSha: sha, runtimeImage, receipt: fx.receipt })).toThrow(/secret|unknown field|redact|structured|analysis/i)
    }
  })
})
