import { PaneReconcileRequestSchema, PaneReconcileResultSchema } from '../../../shared/ws-protocol.js'

export type FreshAgentAttachRoundTarget = {
  sessionId: string
  provider: string
  sessionType?: string
  viewId: string
  tabId: string
  paneId: string
}
export type FreshAgentAttachObservation = {
  frameIndex: number
  roundId: string
  viewId: unknown
  tabId: unknown
  paneId: unknown
  observedEpoch: unknown
  observedGeneration: unknown
  retryAfterSessionReserved: boolean
  retryAfterRestoreUnavailable: boolean
}

export type FreshAgentAttachRound = {
  id: string
  kind: 'initial' | 'ready' | 'reconcile'
  authorizationFrameIndex: number
  bootId?: string
  reconcileId?: string
  targetVerdict?: string
  respawnCreateRequestId?: string
  respawnNullBootstrapFrameIndex?: number
  respawnCreatedFrameIndex?: number
  respawnCommittedOwnerFrames?: Array<{ frameIndex: number; fence: OwnerFence }>
  respawnCommittedOwnerFence?: { epoch: number; generation: number }
  respawnCommittedOwnerFrameIndex?: number
  attachments: FreshAgentAttachObservation[]
  duplicateAttachments: FreshAgentAttachObservation[]
}

export type FreshAgentAttachRoundAnalysis = {
  rounds: FreshAgentAttachRound[]
  validReconcileRoundIds: string[]
}

type JsonRow = Record<string, unknown>

type ReadyContext = {
  bootId: string
  serverInstanceId: string
}

export type OwnerFence = { epoch: number; generation: number }

function ownerFence(frame: JsonRow): OwnerFence | null {
  return typeof frame.epoch === 'number' && Number.isInteger(frame.epoch) && frame.epoch >= 0
    && typeof frame.generation === 'number' && Number.isInteger(frame.generation) && frame.generation >= 0
    ? { epoch: frame.epoch, generation: frame.generation }
    : null
}

type PendingReconcile = {
  ready: ReadyContext
  panes: JsonRow[]
  targetPaneKey: string
  targetCreateRequestId: string
  sourceRound: MutableRound
  round: MutableRound
} | null

type PendingSnapshotRequest = {
  roundId: string
  requestFrameIndex: number
  attachmentFrameIndex: number
  fence: OwnerFence
} | null

type MutableRound = FreshAgentAttachRound & {
  reservedRetriesGranted: number
  reservedRetriesUsed: number
  reservedRetryFences: Array<{ observedEpoch: unknown; observedGeneration: unknown }>
  restoreUnavailableRetriesGranted: number
  restoreUnavailableRetriesUsed: number
  restoreUnavailableRetryFences: OwnerFence[]
  respawnCreateRequestId?: string
  respawnNullBootstrapFrameIndex?: number
  respawnCreatedFrameIndex?: number
  respawnCommittedOwnerFrames?: Array<{ frameIndex: number; fence: OwnerFence }>
  respawnCommittedOwnerFence?: OwnerFence
  respawnCommittedOwnerFrameIndex?: number
}

function isRow(value: unknown): value is JsonRow {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function attachMatchesTarget(frame: JsonRow, target: FreshAgentAttachRoundTarget): boolean {
  return frame.direction === 'sent'
    && frame.type === 'freshAgent.attach'
    && frame.sessionId === target.sessionId
    && frame.provider === target.provider
    && (!target.sessionType || frame.sessionType === target.sessionType)
    && frame.viewId === target.viewId
    && frame.tabId === target.tabId
    && frame.paneId === target.paneId
}

function snapshotMatchesTarget(frame: JsonRow, target: FreshAgentAttachRoundTarget): boolean {
  return frame.method === 'GET'
    && frame.provider === target.provider
    && (!target.sessionType || frame.sessionType === target.sessionType)
    && frame.sessionId === target.sessionId
    && frame.viewId === target.viewId
    && frame.tabId === target.tabId
    && frame.paneId === target.paneId
}

function sameFence(left: OwnerFence | null | undefined, right: OwnerFence | null | undefined): boolean {
  return left !== null && left !== undefined && right !== null && right !== undefined
    && left.epoch === right.epoch && left.generation === right.generation
}

function isPositiveVerdict(verdict: unknown): verdict is 'attach' | 'respawn' | 'fresh' {
  return verdict === 'attach' || verdict === 'respawn' || verdict === 'fresh'
}

function matchesSessionIdentity(pane: JsonRow, target: FreshAgentAttachRoundTarget): boolean {
  if (isRow(pane.sessionRef)) {
    return pane.sessionRef.provider === target.provider
      && pane.sessionRef.sessionId === target.sessionId
  }
  return pane.resumeSessionId === target.sessionId
}

function targetReservedError(frame: JsonRow, target: FreshAgentAttachRoundTarget): boolean {
  if (frame.direction !== 'received' || frame.type !== 'freshAgent.event') return false
  if (frame.sessionId !== target.sessionId || frame.provider !== target.provider) return false
  if (target.sessionType && frame.sessionType !== target.sessionType) return false
  if (frame.requestId !== undefined) return false
  const event = isRow(frame.event) ? frame.event : undefined
  if (!event || event.type !== 'freshAgent.error' || event.code !== 'SESSION_RESERVED') return false
  // Attach refusals have no request id or retryable field. Those fields
  // identify other failure paths, which cannot authorize an attach redrive.
  if (event.requestId !== undefined || event.rollback === true) return false
  for (const key of ['viewId', 'tabId', 'paneId'] as const) {
    const observed = event[key] ?? frame[key]
    if (observed !== undefined && observed !== target[key]) return false
  }
  return true
}

function targetPaneForRequest(panes: JsonRow[], target: FreshAgentAttachRoundTarget): JsonRow | null {
  const paneKey = target.tabId + ':' + target.paneId
  const matches = panes.filter((pane) => pane.paneKey === paneKey)
  if (matches.length !== 1) return null
  const pane = matches[0]
  if (pane.kind !== 'fresh-agent' || pane.mode !== target.provider) return null
  if (!matchesSessionIdentity(pane, target)) return null
  return pane
}

function validTargetReconcileVerdict(
  frame: JsonRow,
  pending: PendingReconcile,
  target: FreshAgentAttachRoundTarget,
): string | null {
  if (!pending) return null
  if (frame.direction !== 'received' || frame.type !== 'pane.reconcile.result') return null
  if (!PaneReconcileResultSchema.safeParse(frame).success) return null
  if (frame.bootId !== pending.ready.bootId || frame.serverInstanceId !== pending.ready.serverInstanceId) return null
  const verdicts = Array.isArray(frame.verdicts) ? frame.verdicts : null
  if (!verdicts || verdicts.length !== pending.panes.length) return null
  const seenKeys = new Set<string>()
  for (let index = 0; index < pending.panes.length; index += 1) {
    const pane = pending.panes[index]
    const verdict = verdicts[index]
    if (!isRow(pane) || !isRow(verdict)) return null
    const requestKey = nonEmptyString(pane.paneKey)
    const verdictKey = nonEmptyString(verdict.paneKey)
    if (!requestKey || requestKey !== verdictKey || seenKeys.has(requestKey)) return null
    seenKeys.add(requestKey)
  }
  const targetPaneKey = target.tabId + ':' + target.paneId
  if (pending.targetPaneKey !== targetPaneKey) return null
  const verdict = verdicts.find((candidate) => isRow(candidate) && candidate.paneKey === targetPaneKey)
  if (!isRow(verdict) || !isPositiveVerdict(verdict.verdict)) return null
  // A missing attach identity is skipped by the actual fresh-agent fold; a
  // corrected foreign identity authorizes that conversation, not this target.
  if (verdict.verdict !== 'fresh' && !matchesSessionIdentity(verdict, target)) return null
  return verdict.verdict
}

export function analyzeFreshAgentAttachRounds(
  frames: ReadonlyArray<Record<string, unknown>>,
  target: FreshAgentAttachRoundTarget,
): FreshAgentAttachRoundAnalysis {
  let nextRoundNumber = 0
  let currentRound: MutableRound = {
    id: 'initial',
    kind: 'initial',
    authorizationFrameIndex: -1,
    attachments: [],
    duplicateAttachments: [],
    respawnCommittedOwnerFrames: [],
    reservedRetriesGranted: 0,
    reservedRetriesUsed: 0,
    reservedRetryFences: [],
    restoreUnavailableRetriesGranted: 0,
    restoreUnavailableRetriesUsed: 0,
    restoreUnavailableRetryFences: [],
  }
  const rounds: MutableRound[] = [currentRound]
  const validReconcileRoundIds: string[] = []
  const pendingReconciles = new Map<string, PendingReconcile>()
  const pendingSnapshotRequests = new Map<string, PendingSnapshotRequest>()
  const nonDuplicateAttachments = new WeakSet<FreshAgentAttachObservation>()
  let readyContext: ReadyContext | null = null
  let startingOwner: OwnerFence | null = null
  let liveUpgradeFence: OwnerFence | null = null
  let currentFreshAgentOwnerFence: OwnerFence | null = null

  const makeRound = (round: Omit<
    MutableRound,
    'reservedRetriesGranted' | 'reservedRetriesUsed' | 'reservedRetryFences'
      | 'restoreUnavailableRetriesGranted' | 'restoreUnavailableRetriesUsed' | 'restoreUnavailableRetryFences'
  >) => {
    return {
      ...round,
      reservedRetriesGranted: 0,
      reservedRetriesUsed: 0,
      reservedRetryFences: [],
      restoreUnavailableRetriesGranted: 0,
      restoreUnavailableRetriesUsed: 0,
      restoreUnavailableRetryFences: [],
      respawnCommittedOwnerFrames: [],
    }
  }

  const startRound = (round: Omit<
    MutableRound,
    'reservedRetriesGranted' | 'reservedRetriesUsed' | 'reservedRetryFences'
      | 'restoreUnavailableRetriesGranted' | 'restoreUnavailableRetriesUsed' | 'restoreUnavailableRetryFences'
  >) => {
    currentRound = makeRound(round)
    rounds.push(currentRound)
  }

  const rollbackPendingRound = (pending: Exclude<PendingReconcile, null>) => {
    const pendingRoundId = pending.round.id
    for (const [requestId, request] of pendingSnapshotRequests) {
      if (request?.roundId === pendingRoundId) pendingSnapshotRequests.delete(requestId)
    }

    const existingDuplicates = new Set(pending.sourceRound.duplicateAttachments)
    for (const attachment of pending.round.attachments) {
      attachment.roundId = pending.sourceRound.id
      if (pending.round.duplicateAttachments.includes(attachment)) {
        existingDuplicates.add(attachment)
      } else if (pending.sourceRound.attachments.length > 0
        && !attachment.retryAfterSessionReserved
        && !attachment.retryAfterRestoreUnavailable
        && !nonDuplicateAttachments.has(attachment)) {
        existingDuplicates.add(attachment)
      }
      pending.sourceRound.attachments.push(attachment)
    }
    pending.sourceRound.attachments.sort((left, right) => left.frameIndex - right.frameIndex)
    pending.sourceRound.duplicateAttachments = pending.sourceRound.attachments
      .filter((attachment) => existingDuplicates.has(attachment))
    if (currentRound === pending.round) currentRound = pending.sourceRound
  }

  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex]
    if (frame.direction === 'received' && frame.type === 'ready') {
      for (const [, pending] of [...pendingReconciles].reverse()) {
        if (pending) rollbackPendingRound(pending)
      }
      pendingReconciles.clear()
      pendingSnapshotRequests.clear()
      startingOwner = null
      liveUpgradeFence = null
      currentFreshAgentOwnerFence = null
      const bootId = nonEmptyString(frame.bootId)
      const serverInstanceId = nonEmptyString(frame.serverInstanceId)
      if (!bootId || !serverInstanceId) {
        readyContext = null
        continue
      }
      readyContext = { bootId, serverInstanceId }
      const readyOwners = Array.isArray(frame.runtimeOwners) ? frame.runtimeOwners.filter(isRow) : []
      const matchingReadyOwners = readyOwners.filter((owner) => owner.provider === target.provider
        && owner.sessionId === target.sessionId
        && owner.ownerKind === 'fresh-agent'
        && owner.state !== 'fenced'
        && owner.state !== 'starting'
        && owner.state !== 'handoff'
        && owner.state !== 'stopping')
      currentFreshAgentOwnerFence = matchingReadyOwners.length === 1
        ? ownerFence(matchingReadyOwners[0])
        : null
      nextRoundNumber += 1
      startRound({
        id: 'ready:' + nextRoundNumber + ':' + bootId,
        kind: 'ready',
        authorizationFrameIndex: frameIndex,
        bootId,
        attachments: [],
        duplicateAttachments: [],
      })
      continue
    }

    if (frame.direction === 'received' && frame.type === 'session.runtimeOwner'
      && frame.provider === target.provider && frame.sessionId === target.sessionId) {
      const fence = frame.ownerKind === 'fresh-agent' ? ownerFence(frame) : null
      currentFreshAgentOwnerFence = frame.transition === 'handoff-committed'
        && frame.ownerKind === 'fresh-agent'
        && fence
        && frame.fenced !== true
        ? fence
        : null
      if (currentRound.kind === 'reconcile'
        && currentRound.targetVerdict === 'respawn'
        && frame.transition === 'handoff-committed'
        && fence
        && nonEmptyString(frame.operationId)
        && frame.fenced !== true) {
        currentRound.respawnCommittedOwnerFrames?.push({ frameIndex, fence })
        currentRound.respawnCommittedOwnerFence = fence
        currentRound.respawnCommittedOwnerFrameIndex = frameIndex
      }
      const observedOwner: OwnerFence | null = startingOwner ?? liveUpgradeFence
      liveUpgradeFence = frame.transition === 'handoff-committed' && fence && observedOwner
        && fence.epoch === observedOwner.epoch && fence.generation === observedOwner.generation
        ? fence : null
      startingOwner = frame.transition === 'handoff-started' ? fence : null
      continue
    }

    if (frame.direction === 'received' && frame.type === 'freshAgent.created') {
      if (currentRound.kind === 'reconcile'
        && currentRound.targetVerdict === 'respawn'
        && currentRound.respawnCreateRequestId
        && frame.requestId === currentRound.respawnCreateRequestId
        && frame.viewId === target.viewId
        && frame.sessionId === target.sessionId
        && frame.provider === target.provider
        && (!target.sessionType || frame.sessionType === target.sessionType)
        && (frame.sessionRef === undefined
          || (isRow(frame.sessionRef)
            && frame.sessionRef.provider === target.provider
            && frame.sessionRef.sessionId === target.sessionId))) {
        currentRound.respawnCreatedFrameIndex = frameIndex
      }
      continue
    }

    if (frame.direction === 'sent' && frame.type === 'pane.reconcile.request') {
      if (!PaneReconcileRequestSchema.safeParse(frame).success) continue
      const reconcileId = nonEmptyString(frame.reconcileId)
      const panes = Array.isArray(frame.panes) && frame.panes.every(isRow) ? frame.panes : null
      if (!readyContext || !reconcileId || !panes) continue
      if (pendingReconciles.has(reconcileId)) {
        const previous = pendingReconciles.get(reconcileId)
        if (previous) rollbackPendingRound(previous)
        pendingReconciles.set(reconcileId, null)
        continue
      }
      const targetPane = targetPaneForRequest(panes, target)
      const targetCreateRequestId = targetPane ? nonEmptyString(targetPane.createRequestId) : null
      if (!targetPane || !targetCreateRequestId || panes.length > 200) {
        pendingReconciles.set(reconcileId, null)
        continue
      }

      const targetPaneKey = target.tabId + ':' + target.paneId
      // A newer reconcile decision supersedes an unfinished one for the same
      // view. Return its captured traffic to the source round before opening
      // the newer window; this keeps the pending attribution one-shot.
      for (const [previousId, previous] of pendingReconciles) {
        if (previous?.targetPaneKey !== targetPaneKey) continue
        rollbackPendingRound(previous)
        pendingReconciles.set(previousId, null)
      }
      const round = makeRound({
        id: 'pending-reconcile:' + reconcileId,
        kind: 'reconcile',
        authorizationFrameIndex: frameIndex,
        bootId: readyContext.bootId,
        reconcileId,
        attachments: [],
        duplicateAttachments: [],
      })
      pendingReconciles.set(reconcileId, {
        ready: readyContext,
        panes,
        targetPaneKey,
        targetCreateRequestId,
        sourceRound: currentRound,
        round,
      })
      currentRound = round
      continue
    }

    if (frame.direction === 'received' && frame.type === 'pane.reconcile.result') {
      const reconcileId = nonEmptyString(frame.reconcileId)
      if (!reconcileId) continue
      const pending = pendingReconciles.get(reconcileId)
      pendingReconciles.delete(reconcileId)
      if (!pending) continue
      const verdict = validTargetReconcileVerdict(frame, pending, target)
      if (!verdict) {
        rollbackPendingRound(pending)
        continue
      }
      const provisionalId = pending.round.id
      nextRoundNumber += 1
      const id = 'reconcile:' + nextRoundNumber + ':' + reconcileId
      pending.round.id = id
      pending.round.authorizationFrameIndex = frameIndex
      pending.round.targetVerdict = verdict
      for (const attachment of pending.round.attachments) attachment.roundId = id
      if (verdict === 'respawn') {
        pending.round.respawnCreateRequestId = pending.targetCreateRequestId
        const nullBootstrap = pending.round.attachments.find((attachment) =>
          attachment.observedEpoch === null && attachment.observedGeneration === null)
        if (nullBootstrap) pending.round.respawnNullBootstrapFrameIndex = nullBootstrap.frameIndex
      }
      for (const [requestId, request] of pendingSnapshotRequests) {
        if (request?.roundId === provisionalId) {
          pendingSnapshotRequests.set(requestId, { ...request, roundId: id })
        } else {
          pendingSnapshotRequests.delete(requestId)
        }
      }
      validReconcileRoundIds.push(reconcileId)
      rounds.push(pending.round)
      continue
    }

    if (frame.direction === 'http-request' && frame.type === 'freshAgent.snapshot.request') {
      const requestId = nonEmptyString(frame.requestId)
      if (!requestId) continue
      const firstAttach = currentRound.attachments.length === 1 ? currentRound.attachments[0] : null
      const firstFence = firstAttach ? ownerFence({
        epoch: firstAttach.observedEpoch,
        generation: firstAttach.observedGeneration,
      }) : null
      const eligibleRequest = snapshotMatchesTarget(frame, target)
        && currentRound.kind === 'reconcile'
        && currentRound.duplicateAttachments.length === 0
        && currentRound.restoreUnavailableRetriesGranted === 0
        && firstAttach !== null
        && !firstAttach.retryAfterSessionReserved
        && !firstAttach.retryAfterRestoreUnavailable
        && firstFence !== null
        && sameFence(firstFence, currentFreshAgentOwnerFence)
        && firstAttach.frameIndex < frameIndex
      pendingSnapshotRequests.set(requestId, eligibleRequest && firstAttach && firstFence
        ? {
          roundId: currentRound.id,
          requestFrameIndex: frameIndex,
          attachmentFrameIndex: firstAttach.frameIndex,
          fence: firstFence,
        }
        : null)
      continue
    }

    if (frame.direction === 'http-response' && frame.type === 'freshAgent.snapshot.response') {
      const requestId = nonEmptyString(frame.requestId)
      if (!requestId) continue
      const request = pendingSnapshotRequests.get(requestId)
      pendingSnapshotRequests.delete(requestId)
      const firstAttach = currentRound.attachments.length === 1 ? currentRound.attachments[0] : null
      const responseOwnerGeneration = typeof frame.ownerGeneration === 'number'
        ? frame.ownerGeneration
        : isRow(frame.body) && typeof frame.body.ownerGeneration === 'number'
          ? frame.body.ownerGeneration
          : null
      const responseOwnerKind = frame.ownerKind ?? (isRow(frame.body) ? frame.body.ownerKind : undefined)
      const responseCode = frame.code ?? (isRow(frame.body) ? frame.body.code : undefined)
      if (request
        && currentRound.kind === 'reconcile'
        && currentRound.id === request.roundId
        && currentRound.duplicateAttachments.length === 0
        && currentRound.restoreUnavailableRetriesGranted === 0
        && currentRound.attachments.length === 1
        && firstAttach?.frameIndex === request.attachmentFrameIndex
        && firstAttach.frameIndex < request.requestFrameIndex
        && request.requestFrameIndex < frameIndex
        && snapshotMatchesTarget(frame, target)
        && frame.status === 409
        && responseCode === 'RESTORE_UNAVAILABLE'
        && responseOwnerKind === 'fresh-agent'
        && responseOwnerGeneration === request.fence.generation
        && sameFence(currentFreshAgentOwnerFence, request.fence)
        && sameFence(ownerFence({
          epoch: firstAttach.observedEpoch,
          generation: firstAttach.observedGeneration,
        }), request.fence)) {
        currentRound.restoreUnavailableRetriesGranted += 1
        currentRound.restoreUnavailableRetryFences.push(request.fence)
      }
      continue
    }

    if (targetReservedError(frame, target)) {
      if (currentRound.attachments.length > currentRound.reservedRetriesGranted) {
        const lastAttachment = currentRound.attachments[currentRound.attachments.length - 1]
        currentRound.reservedRetryFences.push({
          observedEpoch: lastAttachment.observedEpoch,
          observedGeneration: lastAttachment.observedGeneration,
        })
        currentRound.reservedRetriesGranted += 1
      }
      continue
    }

    if (!attachMatchesTarget(frame, target)) continue
    const observedEpoch = frame.observedEpoch ?? null
    const observedGeneration = frame.observedGeneration ?? null
    const authorizedRetryFence = currentRound.reservedRetryFences[currentRound.reservedRetriesUsed]
    const sameCapturedFence = authorizedRetryFence !== undefined
      && authorizedRetryFence.observedEpoch === observedEpoch
      && authorizedRetryFence.observedGeneration === observedGeneration
    const retryAfterSessionReserved = currentRound.attachments.length > 0 && sameCapturedFence
    const restoreUnavailableRetryFence = currentRound.restoreUnavailableRetryFences[
      currentRound.restoreUnavailableRetriesUsed
    ]
    const retryAfterRestoreUnavailable = currentRound.attachments.length > 0
      && restoreUnavailableRetryFence !== undefined
      && restoreUnavailableRetryFence.epoch === observedEpoch
      && restoreUnavailableRetryFence.generation === observedGeneration
    // Outside a reconcile round, the exact peer Starting-to-Live transition
    // grants one newly fenced observation. Reconcile rounds need their own
    // correlated authority; respawn uses the matching created event below.
    const newlyFencedAfterLive = currentRound.kind !== 'reconcile'
      && liveUpgradeFence !== null
      && liveUpgradeFence.epoch === observedEpoch && liveUpgradeFence.generation === observedGeneration
      && currentRound.attachments.length > 0
      && currentRound.attachments.every((attachment) => attachment.observedEpoch === null
        && attachment.observedGeneration === null)
    const respawnCommittedFence = currentRound.respawnCommittedOwnerFence
    // A captured unfenced bootstrap may reach the wire before or after the
    // created reply / owner broadcast. Both authority frames must belong to
    // this respawn round and precede the upgrade, regardless of their order.
    const newlyFencedAfterRespawn = currentRound.kind === 'reconcile'
      && currentRound.targetVerdict === 'respawn'
      && currentRound.respawnNullBootstrapFrameIndex !== undefined
      && currentRound.respawnCreatedFrameIndex !== undefined
      && currentRound.respawnCreatedFrameIndex > currentRound.authorizationFrameIndex
      && respawnCommittedFence !== undefined
      && respawnCommittedFence.epoch === observedEpoch
      && respawnCommittedFence.generation === observedGeneration
      && currentRound.attachments.length > 0
      && currentRound.duplicateAttachments.length === 0
      && currentRound.attachments.every((attachment) => attachment.observedEpoch === null
        && attachment.observedGeneration === null)
    if (authorizedRetryFence && !sameCapturedFence) {
      // The next send changed its captured pair, so the refusal cannot
      // authorize a later send to masquerade as a retry of the old attempt.
      currentRound.reservedRetriesUsed = currentRound.reservedRetriesGranted
    }
    if (restoreUnavailableRetryFence && !retryAfterRestoreUnavailable) {
      // A different fence cannot consume the typed snapshot refusal and then
      // leave that one-shot authority for a later, unrelated attachment.
      currentRound.restoreUnavailableRetriesUsed = currentRound.restoreUnavailableRetriesGranted
    }
    if (observedEpoch === null && observedGeneration === null
      && currentRound.kind === 'reconcile'
      && currentRound.targetVerdict === 'respawn'
      && currentRound.respawnNullBootstrapFrameIndex === undefined) {
      currentRound.respawnNullBootstrapFrameIndex = frameIndex
    }
    const observation: FreshAgentAttachObservation = {
      frameIndex,
      roundId: currentRound.id,
      viewId: frame.viewId ?? null,
      tabId: frame.tabId ?? null,
      paneId: frame.paneId ?? null,
      observedEpoch,
      observedGeneration,
      retryAfterSessionReserved,
      retryAfterRestoreUnavailable,
    }
    currentRound.attachments.push(observation)
    liveUpgradeFence = null
    if (retryAfterSessionReserved) currentRound.reservedRetriesUsed += 1
    if (retryAfterRestoreUnavailable) currentRound.restoreUnavailableRetriesUsed += 1
    if (!retryAfterSessionReserved && !retryAfterRestoreUnavailable
      && currentRound.attachments.length > 1 && !newlyFencedAfterLive && !newlyFencedAfterRespawn) {
      currentRound.duplicateAttachments.push(observation)
    }
  }

  return {
    rounds: rounds
      .filter((round) => round.kind !== 'initial' || round.attachments.length > 0)
      .map(({
        reservedRetriesGranted: _granted,
        reservedRetriesUsed: _used,
        reservedRetryFences: _fences,
        restoreUnavailableRetriesGranted: _restoreUnavailableGranted,
        restoreUnavailableRetriesUsed: _restoreUnavailableUsed,
        restoreUnavailableRetryFences: _restoreUnavailableFences,
        ...round
      }) => round),
    validReconcileRoundIds,
  }
}

/**
 * Check the authoritative action for one positive reconcile result. An
 * `attach` verdict must produce exactly one current-fence attach. A `respawn`
 * verdict completes either through the exact pane create acknowledgment plus
 * a current committed owner, or through one exact target attach sent after a
 * matching current owner commits in that same reconcile round.
 */
export function hasAuthoritativeFreshAgentRecoveryAction(
  round: FreshAgentAttachRound,
  expectedFence: OwnerFence,
): boolean {
  if (round.kind !== 'reconcile' || round.duplicateAttachments.length > 0) return false
  if (round.targetVerdict === 'attach') {
    const authoritativeAttaches = round.attachments.filter((attachment) =>
      !attachment.retryAfterSessionReserved
      && !attachment.retryAfterRestoreUnavailable
      && attachment.observedEpoch === expectedFence.epoch
      && attachment.observedGeneration === expectedFence.generation)
    return authoritativeAttaches.length === 1
  }
  if (round.targetVerdict !== 'respawn') return false
  const matchingOwnerFrames = round.respawnCommittedOwnerFrames?.filter((owner) =>
    owner.frameIndex > round.authorizationFrameIndex
    && owner.fence.epoch === expectedFence.epoch
    && owner.fence.generation === expectedFence.generation) ?? []
  const exactCreate = round.respawnCreateRequestId !== undefined
    && round.respawnCreatedFrameIndex !== undefined
    && round.respawnCreatedFrameIndex > round.authorizationFrameIndex
    && matchingOwnerFrames.length > 0
  if (exactCreate) return true

  const authoritativeAttaches = round.attachments.filter((attachment) =>
    !attachment.retryAfterSessionReserved
    && !attachment.retryAfterRestoreUnavailable
    && attachment.observedEpoch === expectedFence.epoch
    && attachment.observedGeneration === expectedFence.generation)
  if (authoritativeAttaches.length !== 1) return false
  const authoritativeAttach = authoritativeAttaches[0]
  const onlyAuthorizedAttachAttempts = round.attachments.every((attachment) =>
    attachment === authoritativeAttach
    || (attachment.retryAfterSessionReserved
      && attachment.observedEpoch === expectedFence.epoch
      && attachment.observedGeneration === expectedFence.generation)
    || (attachment.retryAfterRestoreUnavailable
      && attachment.observedEpoch === expectedFence.epoch
      && attachment.observedGeneration === expectedFence.generation))
  return onlyAuthorizedAttachAttempts
    && matchingOwnerFrames.some((owner) => owner.frameIndex < authoritativeAttach.frameIndex)
}
