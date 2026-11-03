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
}

export type FreshAgentAttachRound = {
  id: string
  kind: 'initial' | 'ready' | 'reconcile'
  authorizationFrameIndex: number
  bootId?: string
  reconcileId?: string
  targetVerdict?: string
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

type OwnerFence = { epoch: number; generation: number }

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
} | null

type MutableRound = FreshAgentAttachRound & {
  reservedRetriesGranted: number
  reservedRetriesUsed: number
  reservedRetryFences: Array<{ observedEpoch: unknown; observedGeneration: unknown }>
  respawnCreateRequestId?: string
  respawnNullBootstrapFrameIndex?: number
  respawnCreatedFrameIndex?: number
  respawnCommittedOwnerFence?: OwnerFence
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
    reservedRetriesGranted: 0,
    reservedRetriesUsed: 0,
    reservedRetryFences: [],
  }
  const rounds: MutableRound[] = [currentRound]
  const validReconcileRoundIds: string[] = []
  const pendingReconciles = new Map<string, PendingReconcile>()
  let readyContext: ReadyContext | null = null
  let startingOwner: OwnerFence | null = null
  let liveUpgradeFence: OwnerFence | null = null

  const startRound = (round: Omit<
    MutableRound,
    'reservedRetriesGranted' | 'reservedRetriesUsed' | 'reservedRetryFences'
  >) => {
    currentRound = {
      ...round,
      reservedRetriesGranted: 0,
      reservedRetriesUsed: 0,
      reservedRetryFences: [],
    }
    rounds.push(currentRound)
  }

  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex]
    if (frame.direction === 'received' && frame.type === 'ready') {
      pendingReconciles.clear()
      startingOwner = null
      liveUpgradeFence = null
      const bootId = nonEmptyString(frame.bootId)
      const serverInstanceId = nonEmptyString(frame.serverInstanceId)
      if (!bootId || !serverInstanceId) {
        readyContext = null
        continue
      }
      readyContext = { bootId, serverInstanceId }
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
      if (currentRound.kind === 'reconcile'
        && currentRound.targetVerdict === 'respawn'
        && frame.transition === 'handoff-committed'
        && fence
        && nonEmptyString(frame.operationId)
        && frame.fenced !== true) {
        currentRound.respawnCommittedOwnerFence = fence
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
      const targetPane = targetPaneForRequest(panes, target)
      const targetCreateRequestId = targetPane ? nonEmptyString(targetPane.createRequestId) : null
      const currentPending = pendingReconciles.get(reconcileId)
      pendingReconciles.set(reconcileId, currentPending === undefined
        ? targetPane && targetCreateRequestId && panes.length <= 200
          ? {
            ready: readyContext,
            panes,
            targetPaneKey: target.tabId + ':' + target.paneId,
            targetCreateRequestId,
          }
          : null
        : null)
      continue
    }

    if (frame.direction === 'received' && frame.type === 'pane.reconcile.result') {
      const reconcileId = nonEmptyString(frame.reconcileId)
      if (!reconcileId) continue
      const pending = pendingReconciles.get(reconcileId)
      pendingReconciles.delete(reconcileId)
      const verdict = validTargetReconcileVerdict(frame, pending ?? null, target)
      if (!verdict || !pending) continue
      nextRoundNumber += 1
      const id = 'reconcile:' + nextRoundNumber + ':' + reconcileId
      validReconcileRoundIds.push(reconcileId)
      startRound({
        id,
        kind: 'reconcile',
        authorizationFrameIndex: frameIndex,
        bootId: pending.ready.bootId,
        reconcileId,
        targetVerdict: verdict,
        ...(verdict === 'respawn' ? { respawnCreateRequestId: pending.targetCreateRequestId } : {}),
        attachments: [],
        duplicateAttachments: [],
      })
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
    }
    currentRound.attachments.push(observation)
    liveUpgradeFence = null
    if (retryAfterSessionReserved) currentRound.reservedRetriesUsed += 1
    else if (currentRound.attachments.length > 1 && !newlyFencedAfterLive && !newlyFencedAfterRespawn) {
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
        ...round
      }) => round),
    validReconcileRoundIds,
  }
}
