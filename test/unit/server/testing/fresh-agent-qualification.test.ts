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
    freshclaude: { provider: 'claude', version: '2.1.263', model: 'haiku', effort: 'low', variant: 'claude-agent-sdk', pending: true },
    kilroy: { provider: 'claude', version: '2.1.263', model: 'haiku', effort: 'low', variant: 'kilroy-claude-agent-sdk', pending: true },
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
      { turnId: `turn-${mode}-1`, assistantMessageId: `assistant-${mode}-1`, completionKind: 'provider_native_completed' },
      { turnId: `turn-${mode}-2`, assistantMessageId: `assistant-${mode}-2`, completionKind: 'provider_native_completed' },
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
  fs.writeFileSync(path.join(repoRoot, 'docker/runtime/provider-versions.json'), JSON.stringify({
    providers: {
      claude: { version: '2.1.263' },
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
})

describe('fresh-agent release scope truth', () => {
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
