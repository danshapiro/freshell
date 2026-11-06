import { describe, expect, it } from 'vitest'
import {
  analyzeFreshAgentAttachRounds,
  hasAuthoritativeFreshAgentRecoveryAction,
} from '../../e2e-browser/helpers/fresh-agent-attach-rounds.js'

const target = {
  sessionId: 'ses-shared',
  provider: 'claude',
  sessionType: 'freshclaude',
  viewId: 'view-target',
  tabId: 'tab-target',
  paneId: 'pane-target',
}

const attach = (epoch: number | null, generation: number | null, overrides: Record<string, unknown> = {}) => ({
  direction: 'sent',
  type: 'freshAgent.attach',
  sessionId: target.sessionId,
  provider: target.provider,
  sessionType: target.sessionType,
  viewId: target.viewId,
  tabId: target.tabId,
  paneId: target.paneId,
  ...(epoch === null ? {} : { observedEpoch: epoch }),
  ...(generation === null ? {} : { observedGeneration: generation }),
  ...overrides,
})

const ready = (bootId = 'boot-one') => ({
  direction: 'received',
  type: 'ready',
  bootId,
  serverInstanceId: 'server-one',
})

const request = (reconcileId = 'reconcile-one', panes = [targetPane()]) => ({
  direction: 'sent',
  type: 'pane.reconcile.request',
  reconcileId,
  panes,
})

const targetPane = () => ({
  paneKey: `${target.tabId}:${target.paneId}`,
  kind: 'fresh-agent',
  mode: target.provider,
  createRequestId: 'create-target',
  sessionRef: { provider: target.provider, sessionId: target.sessionId },
})

const created = (overrides: Record<string, unknown> = {}) => ({
  direction: 'received',
  type: 'freshAgent.created',
  requestId: 'create-target',
  viewId: target.viewId,
  sessionId: target.sessionId,
  sessionType: target.sessionType,
  provider: target.provider,
  runtimeProvider: 'claude',
  sessionRef: { provider: target.provider, sessionId: target.sessionId },
  ...overrides,
})

const committedOwner = (overrides: Record<string, unknown> = {}) => ({
  direction: 'received',
  type: 'session.runtimeOwner',
  provider: target.provider,
  sessionId: target.sessionId,
  epoch: 2,
  generation: 1,
  ownerKind: 'fresh-agent',
  operationId: 'recovery-operation',
  transition: 'handoff-committed',
  ...overrides,
})

const recoveryInProgressResult = (overrides: Record<string, unknown> = {}) => result('reconcile-one', 'error', {
  verdicts: [{
    paneKey: `${target.tabId}:${target.paneId}`,
    verdict: 'error',
    reason: 'recovery_in_progress',
    sessionRef: { provider: target.provider, sessionId: target.sessionId },
  }],
  ...overrides,
})

const readyWithRecoveringOwner = (overrides: Record<string, unknown> = {}) => ({
  ...ready(),
  runtimeOwners: [{
    provider: target.provider,
    sessionId: target.sessionId,
    epoch: 2,
    generation: 1,
    ownerKind: 'fresh-agent',
    state: 'starting',
  }],
  ...overrides,
})

const snapshotRequest = (requestId = 'snapshot-request', overrides: Record<string, unknown> = {}) => ({
  direction: 'http-request',
  type: 'freshAgent.snapshot.request',
  requestId,
  method: 'GET',
  provider: target.provider,
  sessionType: target.sessionType,
  sessionId: target.sessionId,
  viewId: target.viewId,
  tabId: target.tabId,
  paneId: target.paneId,
  ...overrides,
})

const snapshotRestoreUnavailable = (requestId = 'snapshot-request', overrides: Record<string, unknown> = {}) => ({
  direction: 'http-response',
  type: 'freshAgent.snapshot.response',
  requestId,
  method: 'GET',
  provider: target.provider,
  sessionType: target.sessionType,
  sessionId: target.sessionId,
  viewId: target.viewId,
  tabId: target.tabId,
  paneId: target.paneId,
  status: 409,
  code: 'RESTORE_UNAVAILABLE',
  ownerKind: 'fresh-agent',
  ownerGeneration: 1,
  ...overrides,
})

const result = (
  reconcileId = 'reconcile-one',
  verdict = 'attach',
  overrides: Record<string, unknown> = {},
) => ({
  direction: 'received',
  type: 'pane.reconcile.result',
  reconcileId,
  bootId: 'boot-one',
  serverInstanceId: 'server-one',
  verdicts: [{ paneKey: `${target.tabId}:${target.paneId}`, verdict,
    sessionRef: { provider: target.provider, sessionId: target.sessionId } }],
  ...overrides,
})

const openCodeTarget = {
  ...target,
  provider: 'opencode',
  sessionType: 'freshopencode',
}

const openCodeAttach = (
  epoch: number | null,
  generation: number | null,
  overrides: Record<string, unknown> = {},
) => attach(epoch, generation, {
  provider: openCodeTarget.provider,
  sessionType: openCodeTarget.sessionType,
  ...overrides,
})

const openCodePane = {
  ...targetPane(),
  mode: openCodeTarget.provider,
  sessionRef: { provider: openCodeTarget.provider, sessionId: openCodeTarget.sessionId },
}

const openCodeResult = result('reconcile-one', 'respawn', {
  verdicts: [{
    paneKey: `${openCodeTarget.tabId}:${openCodeTarget.paneId}`,
    verdict: 'respawn',
    sessionRef: { provider: openCodeTarget.provider, sessionId: openCodeTarget.sessionId },
  }],
})

const openCodeSnapshotRequest = (
  requestId = 'snapshot-request',
  overrides: Record<string, unknown> = {},
) => snapshotRequest(requestId, {
  provider: openCodeTarget.provider,
  sessionType: openCodeTarget.sessionType,
  ...overrides,
})

const openCodeSnapshotResponse = (
  requestId = 'snapshot-request',
  overrides: Record<string, unknown> = {},
) => snapshotRestoreUnavailable(requestId, {
  provider: openCodeTarget.provider,
  sessionType: openCodeTarget.sessionType,
  ...overrides,
})

function analyzeOpenCodeRespawn(options: {
  requestOverrides?: Record<string, unknown>
  responseOverrides?: Record<string, unknown>
  responseRequestId?: string
  responseStatus?: number
  beforeSnapshot?: Array<Record<string, unknown>>
  afterSnapshot?: Array<Record<string, unknown>>
  snapshotBeforeOwner?: boolean
} = {}) {
  const start = [
    ready(),
    request('reconcile-one', [openCodePane]),
    openCodeResult,
    openCodeAttach(null, null),
  ]
  const ownerCommit = [
    created({
      provider: openCodeTarget.provider,
      runtimeProvider: openCodeTarget.provider,
      sessionType: openCodeTarget.sessionType,
      sessionRef: { provider: openCodeTarget.provider, sessionId: openCodeTarget.sessionId },
    }),
    committedOwner({ provider: openCodeTarget.provider }),
  ]
  const snapshotRequestFrame = openCodeSnapshotRequest('snapshot-request', options.requestOverrides)
  const snapshotResponseFrame = openCodeSnapshotResponse(options.responseRequestId, {
    ...(options.responseStatus === undefined ? {} : { status: options.responseStatus }),
    ...options.responseOverrides,
  })
  const attachFrames = options.snapshotBeforeOwner
    ? [
      snapshotRequestFrame,
      snapshotResponseFrame,
      ...ownerCommit,
      openCodeAttach(2, 1),
      openCodeAttach(2, 1),
    ]
    : [
      ...ownerCommit,
      ...(options.beforeSnapshot ?? [openCodeAttach(2, 1)]),
      snapshotRequestFrame,
      snapshotResponseFrame,
      ...(options.afterSnapshot ?? [openCodeAttach(2, 1)]),
    ]
  const round = analyzeFreshAgentAttachRounds([...start, ...attachFrames], openCodeTarget).rounds[1]
  if (!round) throw new Error('expected a target OpenCode reconcile round')
  return round
}

describe('analyzeFreshAgentAttachRounds', () => {
  it('accepts one recovery-in-progress join only under the current owner fence and its matching commit', () => {
    const exactJoin = analyzeFreshAgentAttachRounds([
      readyWithRecoveringOwner(),
      request(),
      recoveryInProgressResult(),
      attach(2, 1),
      committedOwner(),
    ], target)
    const commitBeforeAttach = analyzeFreshAgentAttachRounds([
      readyWithRecoveringOwner(),
      request(),
      recoveryInProgressResult(),
      committedOwner(),
      attach(2, 1),
    ], target)
    const missingFence = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      recoveryInProgressResult(),
      attach(2, 1),
      committedOwner(),
    ], target)
    const mismatchedFence = analyzeFreshAgentAttachRounds([
      readyWithRecoveringOwner({
        runtimeOwners: [{
          provider: target.provider,
          sessionId: target.sessionId,
          epoch: 2,
          generation: 2,
          ownerKind: 'fresh-agent',
          state: 'starting',
        }],
      }),
      request(),
      recoveryInProgressResult(),
      attach(2, 1),
      committedOwner(),
    ], target)
    const missingCommit = analyzeFreshAgentAttachRounds([
      readyWithRecoveringOwner(),
      request(),
      recoveryInProgressResult(),
      attach(2, 1),
    ], target)
    const duplicateAttach = analyzeFreshAgentAttachRounds([
      readyWithRecoveringOwner(),
      request(),
      recoveryInProgressResult(),
      attach(2, 1),
      attach(2, 1),
      committedOwner(),
    ], target)
    const commitBeforeResult = analyzeFreshAgentAttachRounds([
      readyWithRecoveringOwner(),
      request(),
      committedOwner(),
      recoveryInProgressResult(),
      attach(2, 1),
    ], target)
    const attachBeforeResult = analyzeFreshAgentAttachRounds([
      readyWithRecoveringOwner(),
      request(),
      attach(2, 1),
      recoveryInProgressResult(),
      committedOwner(),
    ], target)
    const mismatchedCommit = analyzeFreshAgentAttachRounds([
      readyWithRecoveringOwner(),
      request(),
      recoveryInProgressResult(),
      attach(2, 1),
      committedOwner({ generation: 2 }),
    ], target)

    expect(exactJoin.validReconcileRoundIds).toEqual(['reconcile-one'])
    expect(commitBeforeAttach.validReconcileRoundIds).toEqual(['reconcile-one'])
    expect(exactJoin.rounds[1]).toMatchObject({
      kind: 'reconcile',
      targetVerdict: 'recovery_in_progress',
      recoveryJoinFence: { epoch: 2, generation: 1 },
      attachments: [{ observedEpoch: 2, observedGeneration: 1 }],
      duplicateAttachments: [],
    })
    expect(hasAuthoritativeFreshAgentRecoveryAction(exactJoin.rounds[1], { epoch: 2, generation: 1 })).toBe(true)
    expect(hasAuthoritativeFreshAgentRecoveryAction(commitBeforeAttach.rounds[1], { epoch: 2, generation: 1 })).toBe(true)

    for (const analysis of [
      missingFence,
      mismatchedFence,
      missingCommit,
      duplicateAttach,
      commitBeforeResult,
      attachBeforeResult,
      mismatchedCommit,
    ]) {
      const round = analysis.rounds.find((candidate) => candidate.targetVerdict === 'recovery_in_progress')
      expect(Boolean(round && hasAuthoritativeFreshAgentRecoveryAction(round, { epoch: 2, generation: 1 }))).toBe(false)
    }
  })

  it('accepts an exact respawn create and current committed owner without requiring a later attach', () => {
    const completedRespawn = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      created(),
      committedOwner(),
    ], target).rounds[1]
    const missingCreated = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      committedOwner(),
    ], target).rounds[1]
    const wrongCreated = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      created({ viewId: 'other-view' }),
      committedOwner(),
    ], target).rounds[1]
    const staleOwner = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      created(),
      committedOwner({ epoch: 3 }),
    ], target).rounds[1]

    expect(completedRespawn.attachments).toEqual([])
    expect(completedRespawn.respawnCreatedFrameIndex).toBeGreaterThan(completedRespawn.authorizationFrameIndex)
    expect(completedRespawn.respawnCommittedOwnerFrameIndex).toBeGreaterThan(completedRespawn.authorizationFrameIndex)
    expect(hasAuthoritativeFreshAgentRecoveryAction(completedRespawn, { epoch: 2, generation: 1 })).toBe(true)
    expect(hasAuthoritativeFreshAgentRecoveryAction(completedRespawn, { epoch: 3, generation: 1 })).toBe(false)
    expect(hasAuthoritativeFreshAgentRecoveryAction(missingCreated, { epoch: 2, generation: 1 })).toBe(false)
    expect(hasAuthoritativeFreshAgentRecoveryAction(wrongCreated, { epoch: 2, generation: 1 })).toBe(false)
    expect(hasAuthoritativeFreshAgentRecoveryAction(staleOwner, { epoch: 2, generation: 1 })).toBe(false)
  })

  it('accepts a respawn attach only after the matching current owner commits in that round', () => {
    const exactAttachRecovery = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      committedOwner(),
      attach(2, 1),
    ], target).rounds[1]
    const ownerAfterAttach = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      attach(2, 1),
      committedOwner(),
    ], target).rounds[1]
    const staleOwner = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      committedOwner({ epoch: 1 }),
      attach(2, 1),
    ], target).rounds[1]
    const wrongSessionOwner = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      committedOwner({ sessionId: 'other-session' }),
      attach(2, 1),
    ], target).rounds[1]
    const ownerBeforeResult = analyzeFreshAgentAttachRounds([
      ready(),
      committedOwner(),
      request(),
      result('reconcile-one', 'respawn'),
      attach(2, 1),
    ], target).rounds[1]
    const wrongViewAttach = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      committedOwner(),
      attach(2, 1, { viewId: 'other-view' }),
    ], target).rounds[1]
    const duplicateAttach = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      committedOwner(),
      attach(2, 1),
      attach(2, 1),
    ], target).rounds[1]

    expect(hasAuthoritativeFreshAgentRecoveryAction(exactAttachRecovery, { epoch: 2, generation: 1 })).toBe(true)
    expect(exactAttachRecovery.respawnCommittedOwnerFrameIndex)
      .toBeLessThan(exactAttachRecovery.attachments[0].frameIndex)
    expect(hasAuthoritativeFreshAgentRecoveryAction(ownerAfterAttach, { epoch: 2, generation: 1 })).toBe(false)
    expect(hasAuthoritativeFreshAgentRecoveryAction(staleOwner, { epoch: 2, generation: 1 })).toBe(false)
    expect(hasAuthoritativeFreshAgentRecoveryAction(wrongSessionOwner, { epoch: 2, generation: 1 })).toBe(false)
    expect(hasAuthoritativeFreshAgentRecoveryAction(ownerBeforeResult, { epoch: 2, generation: 1 })).toBe(false)
    expect(hasAuthoritativeFreshAgentRecoveryAction(wrongViewAttach, { epoch: 2, generation: 1 })).toBe(false)
    expect(hasAuthoritativeFreshAgentRecoveryAction(duplicateAttach, { epoch: 2, generation: 1 })).toBe(false)
  })

  it('continues to require exactly one current-fence attach for an attach verdict', () => {
    const exactAttach = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'attach'),
      attach(2, 1),
    ], target).rounds[1]
    const missingAttach = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'attach'),
    ], target).rounds[1]

    expect(hasAuthoritativeFreshAgentRecoveryAction(exactAttach, { epoch: 2, generation: 1 })).toBe(true)
    expect(hasAuthoritativeFreshAgentRecoveryAction(missingAttach, { epoch: 2, generation: 1 })).toBe(false)
  })

  it('attributes target attaches sent during its pending reconcile request and keeps overlap duplicates visible', () => {
    const attachBeforeResult = analyzeFreshAgentAttachRounds([
      ready(),
      request('pending-target'),
      committedOwner(),
      attach(2, 1),
      result('pending-target', 'attach'),
    ], target)
    const duplicateAcrossResult = analyzeFreshAgentAttachRounds([
      ready(),
      request('pending-target'),
      committedOwner(),
      attach(2, 1),
      result('pending-target', 'attach'),
      attach(2, 1),
    ], target)
    const mismatchedRequest = analyzeFreshAgentAttachRounds([
      ready(),
      request('other-target', [{ ...targetPane(), paneKey: 'other-tab:other-pane' }]),
      committedOwner(),
      attach(2, 1),
      result('other-target', 'attach'),
    ], target)
    const mismatchedSessionRequest = analyzeFreshAgentAttachRounds([
      ready(),
      request('other-session', [{
        ...targetPane(),
        sessionRef: { provider: target.provider, sessionId: 'other-session' },
      }]),
      committedOwner(),
      attach(2, 1),
      result('other-session', 'attach'),
    ], target)
    const supersededByMismatchedSession = analyzeFreshAgentAttachRounds([
      ready(),
      request('matching-session'),
      request('newer-other-session', [{
        ...targetPane(),
        sessionRef: { provider: target.provider, sessionId: 'other-session' },
      }]),
      committedOwner(),
      attach(2, 1),
      result('matching-session', 'attach'),
    ], target)

    expect(attachBeforeResult.rounds[0].attachments).toEqual([])
    expect(attachBeforeResult.rounds[1].attachments).toMatchObject([
      { frameIndex: 3, observedEpoch: 2, observedGeneration: 1 },
    ])
    expect(attachBeforeResult.rounds[1].attachments[0].roundId).toBe(attachBeforeResult.rounds[1].id)
    expect(hasAuthoritativeFreshAgentRecoveryAction(attachBeforeResult.rounds[1], { epoch: 2, generation: 1 })).toBe(true)

    expect(duplicateAcrossResult.rounds[1].attachments).toHaveLength(2)
    expect(duplicateAcrossResult.rounds[1].duplicateAttachments).toEqual([
      duplicateAcrossResult.rounds[1].attachments[1],
    ])
    expect(hasAuthoritativeFreshAgentRecoveryAction(duplicateAcrossResult.rounds[1], { epoch: 2, generation: 1 })).toBe(false)

    expect(mismatchedRequest.validReconcileRoundIds).toEqual([])
    expect(mismatchedRequest.rounds[0].attachments).toHaveLength(1)
    expect(mismatchedSessionRequest.validReconcileRoundIds).toEqual([])
    expect(mismatchedSessionRequest.rounds[0].attachments).toHaveLength(1)
    expect(supersededByMismatchedSession.validReconcileRoundIds).toEqual([])
    expect(supersededByMismatchedSession.rounds[0].attachments).toMatchObject([
      { frameIndex: 4, observedEpoch: 2, observedGeneration: 1 },
    ])
    expect(supersededByMismatchedSession.rounds.map((round) => round.kind)).toEqual(['ready'])
  })

  it('authorizes one same-fence attach retry only after the exact typed snapshot refusal', () => {
    const exactRecovery = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'attach'),
      committedOwner(),
      attach(2, 1),
      snapshotRequest(),
      snapshotRestoreUnavailable(),
      attach(2, 1),
    ], target).rounds[1]
    const duplicateWithoutRefusal = analyzeFreshAgentAttachRounds([
      ready(), request(), result(), attach(2, 1), attach(2, 1),
    ], target).rounds[1]
    const uncorrelatedRefusal = analyzeFreshAgentAttachRounds([
      ready(), request(), result(), attach(2, 1),
      snapshotRequest('snapshot-request', { sessionId: 'other-session' }),
      snapshotRestoreUnavailable('snapshot-request'),
      attach(2, 1),
    ], target).rounds[1]
    const wrongViewRefusal = analyzeFreshAgentAttachRounds([
      ready(), request(), result(), attach(2, 1),
      snapshotRequest('snapshot-request', { viewId: 'other-view' }),
      snapshotRestoreUnavailable('snapshot-request'),
      attach(2, 1),
    ], target).rounds[1]
    const wrongRequestIdRefusal = analyzeFreshAgentAttachRounds([
      ready(), request(), result(), committedOwner(), attach(2, 1),
      snapshotRequest('snapshot-request'),
      snapshotRestoreUnavailable('other-snapshot-request'),
      attach(2, 1),
    ], target).rounds[1]
    const staleRefusal = analyzeFreshAgentAttachRounds([
      ready(), request(), result(),
      snapshotRequest(), snapshotRestoreUnavailable(),
      attach(2, 1), attach(2, 1),
    ], target).rounds[1]
    const wrongGenerationRefusal = analyzeFreshAgentAttachRounds([
      ready(), request(), result(), committedOwner(), attach(2, 1),
      snapshotRequest(), snapshotRestoreUnavailable('snapshot-request', { ownerGeneration: 0 }),
      attach(2, 1),
    ], target).rounds[1]
    const secondExtraAfterRefusal = analyzeFreshAgentAttachRounds([
      ready(), request(), result(), committedOwner(), attach(2, 1),
      snapshotRequest(), snapshotRestoreUnavailable(),
      attach(2, 1), attach(2, 1),
    ], target).rounds[1]

    expect(exactRecovery.attachments.map((item) => item.retryAfterRestoreUnavailable)).toEqual([false, true])
    expect(exactRecovery.duplicateAttachments).toEqual([])
    expect(hasAuthoritativeFreshAgentRecoveryAction(exactRecovery, { epoch: 2, generation: 1 })).toBe(true)
    expect(duplicateWithoutRefusal.duplicateAttachments).toHaveLength(1)
    expect(hasAuthoritativeFreshAgentRecoveryAction(duplicateWithoutRefusal, { epoch: 2, generation: 1 })).toBe(false)
    expect(uncorrelatedRefusal.duplicateAttachments).toHaveLength(1)
    expect(hasAuthoritativeFreshAgentRecoveryAction(uncorrelatedRefusal, { epoch: 2, generation: 1 })).toBe(false)
    expect(wrongViewRefusal.duplicateAttachments).toHaveLength(1)
    expect(wrongRequestIdRefusal.duplicateAttachments).toHaveLength(1)
    expect(staleRefusal.duplicateAttachments).toHaveLength(1)
    expect(wrongGenerationRefusal.duplicateAttachments).toHaveLength(1)
    expect(secondExtraAfterRefusal.attachments.map((item) => item.retryAfterRestoreUnavailable)).toEqual([false, true, false])
    expect(secondExtraAfterRefusal.duplicateAttachments).toEqual([secondExtraAfterRefusal.attachments[2]])
  })

  it('allows one OpenCode snapshot retry after a respawn bootstrap and its unique committed-owner attach', () => {
    const exactRecovery = analyzeOpenCodeRespawn()
    expect(exactRecovery.attachments.map((item) => item.retryAfterRestoreUnavailable))
      .toEqual([false, false, true])
    expect(exactRecovery.duplicateAttachments).toEqual([])
    expect(hasAuthoritativeFreshAgentRecoveryAction(exactRecovery, { epoch: 2, generation: 1 })).toBe(true)
  })

  it('requires a correlated typed 409 for the same OpenCode target and owner generation', () => {
    const invalidResponses = [
      analyzeOpenCodeRespawn({ responseStatus: 200 }),
      analyzeOpenCodeRespawn({ responseRequestId: 'other-snapshot-request' }),
      analyzeOpenCodeRespawn({ responseOverrides: { ownerGeneration: 2 } }),
      analyzeOpenCodeRespawn({ responseOverrides: { sessionId: 'other-session' } }),
      analyzeOpenCodeRespawn({ responseOverrides: { provider: 'claude' } }),
      analyzeOpenCodeRespawn({ responseOverrides: { sessionType: 'freshclaude' } }),
      analyzeOpenCodeRespawn({ responseOverrides: { viewId: 'other-view' } }),
      analyzeOpenCodeRespawn({ responseOverrides: { tabId: 'other-tab' } }),
      analyzeOpenCodeRespawn({ responseOverrides: { paneId: 'other-pane' } }),
    ]
    const invalidRequests = [
      analyzeOpenCodeRespawn({ requestOverrides: { provider: 'claude' } }),
      analyzeOpenCodeRespawn({ requestOverrides: { sessionType: 'freshclaude' } }),
      analyzeOpenCodeRespawn({ requestOverrides: { sessionId: 'other-session' } }),
      analyzeOpenCodeRespawn({ requestOverrides: { viewId: 'other-view' } }),
      analyzeOpenCodeRespawn({ requestOverrides: { tabId: 'other-tab' } }),
      analyzeOpenCodeRespawn({ requestOverrides: { paneId: 'other-pane' } }),
    ]

    expect(invalidResponses.every((round) => round.duplicateAttachments.length === 1)).toBe(true)
    expect(invalidRequests.every((round) => round.duplicateAttachments.length === 1)).toBe(true)
  })

  it('does not reuse a snapshot refusal before its fence witness or for a second retry', () => {
    const responseBeforeFenceWitness = analyzeOpenCodeRespawn({ snapshotBeforeOwner: true })
    const secondRetry = analyzeOpenCodeRespawn({
      afterSnapshot: [openCodeAttach(2, 1), openCodeAttach(2, 1)],
    })

    expect(responseBeforeFenceWitness.attachments.map((item) => item.retryAfterRestoreUnavailable))
      .toEqual([false, false, false])
    expect(responseBeforeFenceWitness.duplicateAttachments).toEqual([responseBeforeFenceWitness.attachments[2]])
    expect(secondRetry.attachments.map((item) => item.retryAfterRestoreUnavailable))
      .toEqual([false, false, true, false])
    expect(secondRetry.duplicateAttachments).toEqual([secondRetry.attachments[3]])
  })

  it('does not authorize a typed snapshot retry when more than one owner-fenced attach is present', () => {
    const multipleFencedWitnesses = analyzeOpenCodeRespawn({
      beforeSnapshot: [openCodeAttach(2, 1), openCodeAttach(2, 1)],
    })

    expect(multipleFencedWitnesses.attachments.map((item) => item.retryAfterRestoreUnavailable))
      .toEqual([false, false, false, false])
    expect(multipleFencedWitnesses.duplicateAttachments).toEqual([
      multipleFencedWitnesses.attachments[2],
      multipleFencedWitnesses.attachments[3],
    ])
  })

  it('keeps an all-200 duplicate attachment unauthorized after a respawn round', () => {
    const all200Duplicate = analyzeOpenCodeRespawn({ responseStatus: 200 })

    expect(all200Duplicate.attachments.map((item) => item.retryAfterRestoreUnavailable))
      .toEqual([false, false, false])
    expect(all200Duplicate.duplicateAttachments).toHaveLength(1)
  })

  it('detects duplicate sends within one ready round but allows a same-fence later round', () => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      attach(1, 1),
      attach(1, 1),
      request(),
      result(),
      attach(1, 1),
      ready(),
      attach(1, 1),
    ], target)

    expect(analysis.rounds.map((round) => ({
      kind: round.kind,
      bootId: round.bootId,
      reconcileId: round.reconcileId,
      attachments: round.attachments.length,
      duplicates: round.duplicateAttachments.length,
    }))).toEqual([
      { kind: 'ready', bootId: 'boot-one', reconcileId: undefined, attachments: 2, duplicates: 1 },
      { kind: 'reconcile', bootId: 'boot-one', reconcileId: 'reconcile-one', attachments: 1, duplicates: 0 },
      { kind: 'ready', bootId: 'boot-one', reconcileId: undefined, attachments: 1, duplicates: 0 },
    ])
    expect(analysis.rounds[0].attachments[0]).toMatchObject({
      observedEpoch: 1,
      observedGeneration: 1,
    })
    expect(analysis.validReconcileRoundIds).toEqual(['reconcile-one'])
  })

  it('preserves an unfenced bootstrap separately from the later authoritative fence', () => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      attach(null, null),
      request(),
      result(),
      attach(2, 1),
    ], target)

    expect(analysis.rounds.map((round) => round.attachments.map((item) => [
      item.observedEpoch,
      item.observedGeneration,
    ]))).toEqual([[[null, null]], [[2, 1]]])
  })

  it('allows one null-to-fenced respawn upgrade after the matching create and committed owner', () => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      attach(null, null),
      created(),
      committedOwner(),
      attach(2, 1),
      attach(2, 1),
    ], target)

    expect(analysis.rounds).toHaveLength(2)
    expect(analysis.rounds[1]).toMatchObject({
      kind: 'reconcile',
      targetVerdict: 'respawn',
      attachments: [
        { observedEpoch: null, observedGeneration: null },
        { observedEpoch: 2, observedGeneration: 1 },
        { observedEpoch: 2, observedGeneration: 1 },
      ],
      duplicateAttachments: [{ observedEpoch: 2, observedGeneration: 1 }],
    })
  })

  it.each([
    ['created', 'bootstrap', 'owner'],
    ['owner', 'bootstrap', 'created'],
    ['created', 'owner', 'bootstrap'],
  ])('accepts respawn authority around a queued bootstrap in wire order %s / %s / %s', (...order) => {
    const frames: Record<string, Record<string, unknown>> = {
      created: created(), owner: committedOwner(), bootstrap: attach(null, null),
    }
    const analysis = analyzeFreshAgentAttachRounds([
      ready(), request(), result('reconcile-one', 'respawn'),
      ...order.map((step) => frames[step]),
      attach(2, 1), attach(2, 1),
    ], target)
    expect(analysis.rounds[1].attachments).toHaveLength(3)
    expect(analysis.rounds[1].duplicateAttachments).toEqual([analysis.rounds[1].attachments[2]])
  })

  it.each([
    { created: false },
    { created: true, createOverrides: { viewId: 'other-view' } },
    { created: true, createOverrides: { requestId: 'other-create' } },
    { created: true, createOverrides: { sessionId: 'other-session' } },
    { created: true, createOverrides: { sessionRef: { provider: target.provider, sessionId: 'other-session' } } },
    { created: true, createOverrides: { sessionRef: null } },
    { created: true, ownerOverrides: { operationId: '' } },
    { created: true, ownerOverrides: { epoch: 3 } },
    { created: true, ownerOverrides: { ownerKind: 'terminal' } },
  ])('keeps a respawn fence upgrade duplicate without exact create/owner authority: %j', (options) => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      attach(null, null),
      ...(options.created ? [created(options.createOverrides)] : []),
      committedOwner(options.ownerOverrides),
      attach(2, 1),
    ], target)

    expect(analysis.rounds[1].attachments).toHaveLength(2)
    expect(analysis.rounds[1].duplicateAttachments).toEqual([analysis.rounds[1].attachments[1]])
  })

  it('does not hide a repeated null bootstrap when later respawn authority arrives', () => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      attach(null, null),
      attach(null, null),
      created(),
      committedOwner(),
      attach(2, 1),
    ], target)

    expect(analysis.rounds[1].duplicateAttachments).toEqual([
      analysis.rounds[1].attachments[1],
      analysis.rounds[1].attachments[2],
    ])
  })

  it('requires a respawn verdict and create/owner authority within that round for the fence upgrade', () => {
    const attachVerdict = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'attach'),
      attach(null, null),
      created(),
      committedOwner(),
      attach(2, 1),
    ], target)
    const ownerWithoutCreated = committedOwner()
    const respawnWithoutCreated = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      attach(null, null),
      { ...ownerWithoutCreated, transition: 'handoff-started' },
      ownerWithoutCreated,
      attach(2, 1),
    ], target)
    const earlyAuthority = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      created(),
      committedOwner(),
      result('reconcile-one', 'respawn'),
      attach(null, null),
      attach(2, 1),
    ], target)

    expect(attachVerdict.rounds[1].duplicateAttachments).toEqual([attachVerdict.rounds[1].attachments[1]])
    expect(respawnWithoutCreated.rounds[1].duplicateAttachments).toEqual([
      respawnWithoutCreated.rounds[1].attachments[1],
    ])
    expect(earlyAuthority.rounds[1].duplicateAttachments).toEqual([earlyAuthority.rounds[1].attachments[1]])
  })

  it.each([1, 2])('allows one fenced rearm after the exact target Starting owner becomes Live (%i announcements)', (announcements) => {
    const owner = { direction: 'received', type: 'session.runtimeOwner',
      provider: target.provider, sessionId: target.sessionId, epoch: 2, generation: 1,
      ownerKind: 'fresh-agent', operationId: 'recovered-owner' }
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      attach(null, null),
      { ...owner, transition: 'handoff-started' },
      ...Array.from({ length: announcements }, () => ({ ...owner, transition: 'handoff-committed' })),
      attach(2, 1),
      attach(2, 1),
    ], target)

    expect(analysis.rounds).toHaveLength(1)
    expect(analysis.rounds[0].attachments).toHaveLength(3)
    expect(analysis.rounds[0].duplicateAttachments).toEqual([analysis.rounds[0].attachments[2]])
  })

  it.each([
    { sessionId: 'foreign-session' },
    { provider: 'foreign-provider' },
    { generation: 2 },
    { ownerKind: 'terminal' },
  ])('does not authorize a fenced rearm from another owner transition: %j', (overrides) => {
    const owner = { direction: 'received', type: 'session.runtimeOwner',
      provider: target.provider, sessionId: target.sessionId, epoch: 2, generation: 1,
      ownerKind: 'fresh-agent', operationId: 'recovered-owner', ...overrides }
    const analysis = analyzeFreshAgentAttachRounds([
      ready(), attach(null, null),
      { ...owner, transition: 'handoff-started' },
      { ...owner, transition: 'handoff-committed' },
      attach(2, 1),
    ], target)
    expect(analysis.rounds[0].duplicateAttachments).toHaveLength(1)
  })

  it('rejects malformed reconcile requests and result fields as authorization', () => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(), attach(2, 1),
      { ...request('bad-request'), panes: [{ ...targetPane(), createRequestId: undefined }] },
      result('bad-request'),
      request('bad-result'),
      result('bad-result', 'attach', {
        verdicts: [{ paneKey: `${target.tabId}:${target.paneId}`, verdict: 'attach', reason: 7,
          sessionRef: { provider: target.provider, sessionId: target.sessionId } }],
      }),
      attach(2, 1),
    ], target)
    expect(analysis.validReconcileRoundIds).toEqual([])
    expect(analysis.rounds[0].duplicateAttachments).toHaveLength(1)
  })

  it.each([
    undefined,
    { provider: target.provider, sessionId: 'foreign-session' },
    { provider: 'foreign-provider', sessionId: target.sessionId },
  ])('does not grant an attach round without the target result identity: %j', (sessionRef) => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(), attach(2, 1), request(),
      result('reconcile-one', 'attach', {
        verdicts: [{ paneKey: `${target.tabId}:${target.paneId}`, verdict: 'attach', sessionRef }],
      }),
      attach(2, 1),
    ], target)
    expect(analysis.validReconcileRoundIds).toEqual([])
    expect(analysis.rounds[0].duplicateAttachments).toHaveLength(1)
  })

  it.each(['attach', 'respawn', 'fresh'] as const)(
    'retains an empty authorization round for a positive %s verdict',
    (verdict) => {
      const analysis = analyzeFreshAgentAttachRounds([
        ready(),
        request(),
        result('reconcile-one', verdict),
      ], target)

      expect(analysis.rounds.map((round) => ({
        kind: round.kind,
        targetVerdict: round.targetVerdict,
        attachments: round.attachments,
      }))).toEqual([
        { kind: 'ready', targetVerdict: undefined, attachments: [] },
        { kind: 'reconcile', targetVerdict: verdict, attachments: [] },
      ])
    },
  )

  it('requires a correlated, complete, positive target verdict before opening a reconcile round', () => {
    const otherPane = { ...targetPane(), paneKey: 'other-tab:other-pane' }
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      request('wrong-key', [otherPane]),
      result('wrong-key', 'attach', {
        verdicts: [{ paneKey: otherPane.paneKey, verdict: 'attach' }],
      }),
      request('bad-cardinality'),
      result('bad-cardinality', 'attach', { verdicts: [] }),
      request('mismatched-result'),
      result('foreign-result-id'),
      request('negative-target'),
      result('negative-target', 'error'),
      attach(2, 1),
      attach(2, 1),
    ], target)

    expect(analysis.validReconcileRoundIds).toEqual([])
    expect(analysis.rounds).toHaveLength(1)
    expect(analysis.rounds[0].attachments).toHaveLength(2)
    expect(analysis.rounds[0].duplicateAttachments).toHaveLength(1)
  })

  it('allows one same-fence retry after a target SESSION_RESERVED response only', () => {
    const reserved = (overrides: Record<string, unknown> = {}) => ({
      direction: 'received',
      type: 'freshAgent.event',
      sessionId: target.sessionId,
      provider: target.provider,
      sessionType: target.sessionType,
      event: { type: 'freshAgent.error', code: 'SESSION_RESERVED', ...overrides },
    })
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      attach(null, null),
      reserved({ requestId: 'create-request' }),
      attach(null, null),
      reserved(),
      attach(null, null),
      reserved({ viewId: 'other-view' }),
      attach(null, null),
    ], target)

    expect(analysis.rounds).toHaveLength(1)
    expect(analysis.rounds[0].attachments.map((item) => item.retryAfterSessionReserved)).toEqual([
      false,
      false,
      true,
      false,
    ])
    expect(analysis.rounds[0].duplicateAttachments).toEqual([
      analysis.rounds[0].attachments[1],
      analysis.rounds[0].attachments[3],
    ])
  })

  it('does not let SESSION_RESERVED authorize a retry with a changed captured fence', () => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      attach(2, 1),
      {
        direction: 'received',
        type: 'freshAgent.event',
        sessionId: target.sessionId,
        provider: target.provider,
        sessionType: target.sessionType,
        event: { type: 'freshAgent.error', code: 'SESSION_RESERVED' },
      },
      attach(2, 2),
    ], target)

    expect(analysis.rounds[0].attachments.map((item) => item.retryAfterSessionReserved)).toEqual([false, false])
    expect(analysis.rounds[0].duplicateAttachments).toEqual([analysis.rounds[0].attachments[1]])
  })

  it('ignores attach frames and reservation responses for another session or pane', () => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      attach(2, 1, { viewId: 'other-view' }),
      attach(2, 1, { provider: 'opencode' }),
      {
        direction: 'received',
        type: 'freshAgent.event',
        sessionId: 'ses-other',
        provider: target.provider,
        sessionType: target.sessionType,
        event: { type: 'freshAgent.error', code: 'SESSION_RESERVED' },
      },
      attach(2, 1),
    ], target)

    expect(analysis.rounds[0].attachments).toHaveLength(1)
    expect(analysis.rounds[0].attachments[0].viewId).toBe(target.viewId)
    expect(analysis.rounds[0].duplicateAttachments).toHaveLength(0)
  })
})
