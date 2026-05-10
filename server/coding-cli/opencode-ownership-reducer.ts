export type OpencodeSessionStatusType = 'idle' | 'busy' | 'retry'

export type OpencodeSessionStatus = {
  type: OpencodeSessionStatusType
}

export type OpencodeObservation =
  | {
    kind: 'snapshot'
    cycleId: number
    streamId: number
    statuses: Record<string, OpencodeSessionStatus>
    at: number
  }
  | {
    kind: 'sse'
    cycleId: number
    streamId: number
    sessionId: string
    status: OpencodeSessionStatusType
    at: number
  }

export type OpencodeOwnershipState =
  | {
    kind: 'quiet'
    knownSessionId?: string
  }
  | {
    kind: 'candidate'
    sessionId: string
    previousKnownSessionId?: string
    startedBy: 'snapshot' | 'sse'
    cycleId: number
    streamId: number
  }
  | {
    kind: 'knownBusy'
    sessionId: string
    startedBy: 'snapshot' | 'sse'
    cycleId: number
    streamId: number
  }
  | {
    kind: 'awaitingAssociation'
    sessionId: string
    previousKnownSessionId?: string
    cycleId: number
    streamId: number
    completedAt: number
  }
  | {
    kind: 'ambiguous'
    knownSessionId?: string
    blockedSessionIds: string[]
    since: number
  }

export type OpencodeOwnershipAction =
  | {
    kind: 'activityUpsert'
    sessionId?: string
    at: number
  }
  | {
    kind: 'activityRemove'
    at: number
  }
  | {
    kind: 'requestAssociation'
    sessionId: string
  }
  | {
    kind: 'turnComplete'
    sessionId: string
    at: number
  }
  | {
    kind: 'warnAmbiguous'
    sessionIds: string[]
  }

export type OpencodeOwnershipResult = {
  state: OpencodeOwnershipState
  actions: OpencodeOwnershipAction[]
}

export function createOpencodeOwnershipState(knownSessionId?: string): OpencodeOwnershipState {
  return { kind: 'quiet', knownSessionId }
}

function sortedBusySessionIds(statuses: Record<string, OpencodeSessionStatus>): string[] {
  return Object.entries(statuses)
    .filter(([, status]) => status.type !== 'idle')
    .map(([sessionId]) => sessionId)
    .sort()
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort()
}

function sameSessionStream(
  state: Extract<OpencodeOwnershipState, { kind: 'candidate' | 'knownBusy' }>,
  observation: Extract<OpencodeObservation, { kind: 'sse' }>,
): boolean {
  return state.sessionId === observation.sessionId
    && state.cycleId === observation.cycleId
    && state.streamId === observation.streamId
}

function enterAmbiguous(input: {
  knownSessionId?: string
  blockedSessionIds: string[]
  at: number
}): OpencodeOwnershipResult {
  const blockedSessionIds = uniqueSorted(input.blockedSessionIds)
  return {
    state: {
      kind: 'ambiguous',
      knownSessionId: input.knownSessionId,
      blockedSessionIds,
      since: input.at,
    },
    actions: [
      { kind: 'activityUpsert', at: input.at },
      { kind: 'warnAmbiguous', sessionIds: blockedSessionIds },
    ],
  }
}

function reduceBusy(
  state: OpencodeOwnershipState,
  observation: Extract<OpencodeObservation, { kind: 'sse' }>,
): OpencodeOwnershipResult {
  const nextBusyState = {
    sessionId: observation.sessionId,
    startedBy: 'sse' as const,
    cycleId: observation.cycleId,
    streamId: observation.streamId,
  }

  if (state.kind === 'quiet') {
    if (state.knownSessionId === observation.sessionId) {
      return {
        state: { kind: 'knownBusy', ...nextBusyState },
        actions: [{ kind: 'activityUpsert', sessionId: observation.sessionId, at: observation.at }],
      }
    }
    return {
      state: {
        kind: 'candidate',
        previousKnownSessionId: state.knownSessionId,
        ...nextBusyState,
      },
      actions: [{ kind: 'activityUpsert', sessionId: observation.sessionId, at: observation.at }],
    }
  }

  if (state.kind === 'candidate') {
    if (state.sessionId === observation.sessionId) {
      return {
        state: { ...state, cycleId: observation.cycleId, streamId: observation.streamId, startedBy: 'sse' },
        actions: [{ kind: 'activityUpsert', sessionId: observation.sessionId, at: observation.at }],
      }
    }
    return enterAmbiguous({
      knownSessionId: state.previousKnownSessionId,
      blockedSessionIds: [state.sessionId, observation.sessionId],
      at: observation.at,
    })
  }

  if (state.kind === 'knownBusy') {
    if (state.sessionId === observation.sessionId) {
      return {
        state: { ...state, cycleId: observation.cycleId, streamId: observation.streamId, startedBy: 'sse' },
        actions: [{ kind: 'activityUpsert', sessionId: observation.sessionId, at: observation.at }],
      }
    }
    return enterAmbiguous({
      knownSessionId: state.sessionId,
      blockedSessionIds: [state.sessionId, observation.sessionId],
      at: observation.at,
    })
  }

  if (state.kind === 'ambiguous') {
    if (state.blockedSessionIds.includes(observation.sessionId)) {
      return {
        state,
        actions: [{ kind: 'activityUpsert', at: observation.at }],
      }
    }
    const blockedSessionIds = uniqueSorted([...state.blockedSessionIds, observation.sessionId])
    return {
      state: { ...state, blockedSessionIds },
      actions: [
        { kind: 'activityUpsert', at: observation.at },
        { kind: 'warnAmbiguous', sessionIds: blockedSessionIds },
      ],
    }
  }

  return { state, actions: [] }
}

function reduceIdle(
  state: OpencodeOwnershipState,
  observation: Extract<OpencodeObservation, { kind: 'sse' }>,
): OpencodeOwnershipResult {
  if (state.kind === 'candidate') {
    if (!sameSessionStream(state, observation)) return { state, actions: [] }
    return {
      state: {
        kind: 'awaitingAssociation',
        sessionId: state.sessionId,
        previousKnownSessionId: state.previousKnownSessionId,
        cycleId: state.cycleId,
        streamId: state.streamId,
        completedAt: observation.at,
      },
      actions: [
        { kind: 'activityRemove', at: observation.at },
        { kind: 'requestAssociation', sessionId: state.sessionId },
      ],
    }
  }

  if (state.kind === 'knownBusy') {
    if (!sameSessionStream(state, observation)) return { state, actions: [] }
    return {
      state: {
        kind: 'quiet',
        knownSessionId: state.sessionId,
      },
      actions: [
        { kind: 'activityRemove', at: observation.at },
        { kind: 'turnComplete', sessionId: state.sessionId, at: observation.at },
      ],
    }
  }

  if (state.kind === 'ambiguous') {
    if (!state.blockedSessionIds.includes(observation.sessionId)) {
      return { state, actions: [] }
    }

    const blockedSessionIds = state.blockedSessionIds.filter(
      (sessionId) => sessionId !== observation.sessionId,
    )
    if (blockedSessionIds.length === 0) {
      return {
        state: { kind: 'quiet', knownSessionId: state.knownSessionId },
        actions: [{ kind: 'activityRemove', at: observation.at }],
      }
    }

    return {
      state: { ...state, blockedSessionIds },
      actions: [{ kind: 'activityUpsert', at: observation.at }],
    }
  }

  return { state, actions: [] }
}

function reduceSnapshot(
  state: OpencodeOwnershipState,
  observation: Extract<OpencodeObservation, { kind: 'snapshot' }>,
): OpencodeOwnershipResult {
  const busySessionIds = sortedBusySessionIds(observation.statuses)

  if (state.kind === 'ambiguous') {
    if (busySessionIds.length === 0) {
      return {
        state: { kind: 'quiet', knownSessionId: state.knownSessionId },
        actions: [{ kind: 'activityRemove', at: observation.at }],
      }
    }
    const blockedSessionIds = uniqueSorted(busySessionIds)
    if (blockedSessionIds.length === 1) {
      const singleSessionId = blockedSessionIds[0]
      if (state.knownSessionId && singleSessionId === state.knownSessionId) {
        return {
          state: {
            kind: 'knownBusy',
            sessionId: state.knownSessionId,
            startedBy: 'snapshot',
            cycleId: observation.cycleId,
            streamId: observation.streamId,
          },
          actions: [{ kind: 'activityUpsert', sessionId: state.knownSessionId, at: observation.at }],
        }
      }
      if (!state.knownSessionId) {
        return {
          state: {
            kind: 'candidate',
            sessionId: singleSessionId,
            startedBy: 'snapshot',
            cycleId: observation.cycleId,
            streamId: observation.streamId,
          },
          actions: [],
        }
      }
    }
    const changed = blockedSessionIds.length !== state.blockedSessionIds.length
      || blockedSessionIds.some((id, i) => id !== state.blockedSessionIds[i])
    return {
      state: { ...state, blockedSessionIds },
      actions: changed
        ? [
          { kind: 'activityUpsert', at: observation.at },
          { kind: 'warnAmbiguous', sessionIds: blockedSessionIds },
        ]
        : [{ kind: 'activityUpsert', at: observation.at }],
    }
  }

  if (state.kind === 'knownBusy') {
    if (busySessionIds.length === 0) {
      return {
        state: { kind: 'quiet', knownSessionId: state.sessionId },
        actions: [{ kind: 'activityRemove', at: observation.at }],
      }
    }
    if (busySessionIds.length === 1 && busySessionIds[0] === state.sessionId) {
      return {
        state: { ...state, startedBy: 'snapshot', cycleId: observation.cycleId, streamId: observation.streamId },
        actions: [{ kind: 'activityUpsert', sessionId: state.sessionId, at: observation.at }],
      }
    }
    return enterAmbiguous({
      knownSessionId: state.sessionId,
      blockedSessionIds: uniqueSorted([state.sessionId, ...busySessionIds]),
      at: observation.at,
    })
  }

  if (state.kind === 'candidate') {
    if (busySessionIds.length === 0) {
      return {
        state: { kind: 'quiet', knownSessionId: state.previousKnownSessionId },
        actions: [{ kind: 'activityRemove', at: observation.at }],
      }
    }
    if (busySessionIds.length === 1 && busySessionIds[0] === state.sessionId) {
      return {
        state: { ...state, startedBy: 'snapshot', cycleId: observation.cycleId, streamId: observation.streamId },
        actions: [{ kind: 'activityUpsert', sessionId: state.sessionId, at: observation.at }],
      }
    }
    return enterAmbiguous({
      knownSessionId: state.previousKnownSessionId,
      blockedSessionIds: uniqueSorted([state.sessionId, ...busySessionIds]),
      at: observation.at,
    })
  }

  if (state.kind === 'awaitingAssociation') {
    return { state, actions: [] }
  }

  if (busySessionIds.length === 0) {
    return {
      state,
      actions: [{ kind: 'activityRemove', at: observation.at }],
    }
  }

  if (state.knownSessionId && busySessionIds.includes(state.knownSessionId)) {
    if (busySessionIds.length === 1) {
      return {
        state: {
          kind: 'knownBusy',
          sessionId: state.knownSessionId,
          startedBy: 'snapshot',
          cycleId: observation.cycleId,
          streamId: observation.streamId,
        },
        actions: [{ kind: 'activityUpsert', sessionId: state.knownSessionId, at: observation.at }],
      }
    }
    return enterAmbiguous({
      knownSessionId: state.knownSessionId,
      blockedSessionIds: busySessionIds,
      at: observation.at,
    })
  }

  if (busySessionIds.length === 1) {
    return {
      state: {
        kind: 'candidate',
        previousKnownSessionId: state.knownSessionId,
        sessionId: busySessionIds[0],
        startedBy: 'snapshot',
        cycleId: observation.cycleId,
        streamId: observation.streamId,
      },
      actions: [{ kind: 'activityUpsert', sessionId: busySessionIds[0], at: observation.at }],
    }
  }

  return enterAmbiguous({
    knownSessionId: state.knownSessionId,
    blockedSessionIds: busySessionIds,
    at: observation.at,
  })
}

export function reduceOpencodeOwnership(
  state: OpencodeOwnershipState,
  observation: OpencodeObservation,
): OpencodeOwnershipResult {
  if (observation.kind === 'snapshot') {
    return reduceSnapshot(state, observation)
  }
  if (observation.status === 'idle') {
    return reduceIdle(state, observation)
  }
  return reduceBusy(state, observation)
}

export function confirmOpencodeAssociation(
  state: OpencodeOwnershipState,
  input: { sessionId: string },
): OpencodeOwnershipResult {
  if (state.kind !== 'awaitingAssociation' || state.sessionId !== input.sessionId) {
    return { state, actions: [] }
  }
  return {
    state: {
      kind: 'quiet',
      knownSessionId: state.sessionId,
    },
    actions: [{
      kind: 'turnComplete',
      sessionId: state.sessionId,
      at: state.completedAt,
    }],
  }
}

export function rejectOpencodeAssociation(
  state: OpencodeOwnershipState,
  input: { sessionId: string },
): OpencodeOwnershipResult {
  if (state.kind !== 'awaitingAssociation' || state.sessionId !== input.sessionId) {
    return { state, actions: [] }
  }
  return {
    state: {
      kind: 'quiet',
      knownSessionId: state.previousKnownSessionId,
    },
    actions: [],
  }
}
