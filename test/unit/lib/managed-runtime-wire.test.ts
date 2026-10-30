import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import managedRuntimeReducer, { managedRuntimeSnapshotReceived } from '@/store/managedRuntimeSlice'
import {
  ManagedRuntimeRestoreLostSoulsRequestSchema, ManagedRuntimeRepairBatchScopeSchema,
  ManagedRuntimeRestoreLostSoulsResultSchema, ManagedRuntimeInventorySnapshotSchema,
  ManagedRuntimeSoulSchema,
  ManagedRuntimeSoulDetailSchema,
} from '@shared/managed-runtime'

const digest = 'a'.repeat(64)
const targets = Array.from({ length: 9 }, (_, index) => ({
  soulId: `soul-fixture-${index}`, incidentId: `incident-fixture-${index}`, expectedIntentRevision: 2,
}))
const request = {
  idempotencyKey: 'request-fixture-nine', scopeId: digest,
  source: { sourceStoreId: 'b'.repeat(64), rootSessionIds: Array.from({ length: 7 }, (_, index) => `ses_fixture_root_${index}`) },
  targets, canonicalOwners: [{ rootSessionId: 'ses_fixture_root_0', soulId: 'soul-fixture-0', expectedIntentRevision: 2 }],
}

describe('production managed runtime repair wire parsing', () => {
  it('consumes actual production Rust serialization for inventory, detail and legacy observations', () => {
    const produced = JSON.parse(execFileSync('cargo', [
      'run', '--quiet', '--locked', '-p', 'freshell-runtime-protocol', '--example', 'native-identity-wire',
    ], { encoding: 'utf8', timeout: 180_000, maxBuffer: 128 * 1024 }))
    const inventory = ManagedRuntimeInventorySnapshotSchema.parse(produced.inventory)
    const detail = ManagedRuntimeSoulDetailSchema.parse(produced.detail)
    const consumed = managedRuntimeReducer(undefined, managedRuntimeSnapshotReceived({
      snapshot: inventory, reconstructedViewCount: 0,
    }))
    expect(consumed.souls[0]?.nativeIdentityObservation).toEqual(produced.observation)
    expect(detail.soul.nativeIdentityObservation).toEqual(consumed.souls[0]?.nativeIdentityObservation)
    expect(ManagedRuntimeSoulSchema.parse(produced.legacy).nativeIdentityObservation).toBeUndefined()
    for (const change of [{ source: 'requested_id' }, { launchNonce: undefined }, { evidenceRevision: '1' }]) {
      expect(ManagedRuntimeSoulSchema.safeParse({ ...produced.inventory.souls[0],
        nativeIdentityObservation: { ...produced.observation, ...change },
      }).success).toBe(false)
    }
  }, 180_000)
  it('round-trips current native observation and preserves unobserved legacy identity', () => {
    const soul = {
      soulId: 'soul-wire', incarnationId: 'incarnation-wire', launchState: 'running',
      cleanupState: 'none', intentRevision: 1, executionGeneration: 1,
      desiredState: 'running', recoveryState: 'live', durabilityState: 'unknown',
      allocationState: 'allocated', nativeSessionId: 'requested-root',
      evidenceRevision: 1, successfulRecoveriesInWindow: 0,
    }
    const observation = {
      nativeSessionId: 'requested-root', incarnationId: soul.incarnationId,
      launchNonce: 'grant-current', evidenceRevision: 1,
      source: 'claude_native_event', evidenceDigest: digest,
    }
    expect(ManagedRuntimeSoulSchema.parse(JSON.parse(JSON.stringify({
      ...soul, nativeIdentityObservation: observation,
    }))).nativeIdentityObservation).toEqual(observation)
    expect(ManagedRuntimeSoulSchema.parse(soul).nativeIdentityObservation).toBeUndefined()
    for (const invalid of [
      { ...observation, source: 'requested_id' },
      { ...observation, launchNonce: undefined },
      { ...observation, evidenceRevision: '1' },
    ]) {
      expect(ManagedRuntimeSoulSchema.safeParse({ ...soul, nativeIdentityObservation: invalid }).success).toBe(false)
    }
  })
  it('admits the scoped nine-target request through the exported production schema', () => {
    expect(ManagedRuntimeRestoreLostSoulsRequestSchema.parse(request).targets).toHaveLength(9)
  })

  it('rejects absent or malformed scope, duplicate identities and stale choice format', () => {
    const invalid = [
      { ...request, scopeId: undefined }, { ...request, scopeId: 'unknown' },
      { ...request, targets: [targets[0], targets[0], ...targets.slice(2)] },
      { ...request, targets: targets.map((target, index) => index === 1 ? { ...target, incidentId: targets[0]!.incidentId } : target) },
      { ...request, canonicalOwners: [{ ...request.canonicalOwners[0], expectedIntentRevision: 0 }] },
      { ...request, source: { ...request.source, rootSessionIds: ['ses_fixture_root_0', 'ses_fixture_root_0'] } },
    ]
    for (const value of invalid) expect(ManagedRuntimeRestoreLostSoulsRequestSchema.safeParse(value).success).toBe(false)
  })

  it('parses body-free server scope revisions and completed reply counts', () => {
    const scope = ManagedRuntimeRepairBatchScopeSchema.parse({
      scopeId: digest, sourceStoreId: request.source.sourceStoreId, sourceFingerprint: 'c'.repeat(64),
      targets: targets.map((target, index) => ({ target, providerStoreId: `store-${index}`, rootSessionId: request.source.rootSessionIds[index % 7], incidentRevision: 1, identityRevision: 0, nativeImportRevision: 0, evidenceRevision: 0 })),
      roots: request.source.rootSessionIds.map((rootSessionId, index) => ({ rootSessionId, graphDigest: 'd'.repeat(64), eligibleOwners: [`soul-fixture-${index}`], canonicalSoulId: null })),
    })
    const reply = ManagedRuntimeRestoreLostSoulsResultSchema.parse({
      operationId: request.idempotencyKey, scopeId: scope.scopeId, status: 'complete', repairedTargetCount: 9, totalTargetCount: 9,
      roots: scope.roots.map((root) => ({ rootSessionId: root.rootSessionId, canonicalSoulId: root.eligibleOwners[0], importStatus: 'complete', intentRevision: 2, nativeImportRevision: 1 })),
    })
    expect(reply.roots).toHaveLength(7)
    expect(reply.totalTargetCount).toBe(9)
    expect(ManagedRuntimeRestoreLostSoulsResultSchema.safeParse({ ...reply, scopeId: undefined }).success).toBe(false)
  })

  it('keeps the legacy inventory projection parser available alongside scoped repairs', () => {
    const inventory = {
      revision: 0, souls: [], viewIntents: [], pendingProjectionCount: 0,
      readiness: { inventoryRevision: 0, initialScanState: 'pending', blockedSubsystems: [], startupRecoveryConcurrencyLimit: 1, startupRecoveryPeak: 0 },
    }
    expect(ManagedRuntimeInventorySnapshotSchema.parse(inventory).souls).toEqual([])
  })
})
