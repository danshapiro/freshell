export type PendingReplay = { fromSeq: number; toSeq: number } | null
export type LostSeqRange = { fromSeq: number; toSeq: number }

export type OutputFrameDecision =
  | { accept: true; freshReset: boolean; state: AttachSeqState }
  | { accept: false; reason: 'overlap' }

export type OutputGapDecision = {
  state: AttachSeqState
  surfaceSafeForDeltaReplay: boolean
  requiresSurfaceQuarantine: boolean
}

export type OutputBatchAcceptedSegment = {
  seqStart: number
  seqEnd: number
  freshReset: boolean
  parserAppliedSeq: number
  previousState: AttachSeqState
  state: AttachSeqState
}

export type OutputBatchDecision =
  | {
      accept: true
      freshReset: boolean
      state: AttachSeqState
      segments: OutputBatchAcceptedSegment[]
    }
  | {
      accept: false
      reason: 'overlap'
      rejectedSegment: { seqStart: number; seqEnd: number }
      state: AttachSeqState
    }

export type AttachSeqState = {
  /**
   * Backward-compatible alias for highestObservedSeq until TerminalView migrates
   * to the explicit parser-applied checkpoint model.
   */
  lastSeq: number
  highestObservedSeq: number
  parserAppliedSeq: number
  awaitingFreshSequence: boolean
  pendingReplay: PendingReplay
  knownLostRanges: LostSeqRange[]
  surfaceSafeForDeltaReplay: boolean
  requiresSurfaceQuarantine: boolean
}

function normalizeSeq(seq: unknown): number {
  return typeof seq === 'number' && Number.isFinite(seq)
    ? Math.max(0, Math.floor(seq))
    : 0
}

function normalizeLostRanges(ranges: LostSeqRange[] | undefined): LostSeqRange[] {
  if (!ranges?.length) return []
  return mergeLostRanges(ranges.map((range) => {
    const fromSeq = normalizeSeq(range.fromSeq)
    const toSeq = Math.max(fromSeq, normalizeSeq(range.toSeq))
    return { fromSeq, toSeq }
  }).filter((range) => range.toSeq > 0))
}

function mergeLostRanges(ranges: LostSeqRange[]): LostSeqRange[] {
  if (ranges.length === 0) return []

  const sorted = [...ranges].sort((a, b) => a.fromSeq - b.fromSeq)
  const merged: LostSeqRange[] = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (!previous || range.fromSeq > previous.toSeq + 1) {
      merged.push({ ...range })
      continue
    }
    previous.toSeq = Math.max(previous.toSeq, range.toSeq)
  }
  return merged
}

function buildState(input: Partial<AttachSeqState>): AttachSeqState {
  const knownLostRanges = normalizeLostRanges(input.knownLostRanges)
  const parserAppliedSeq = normalizeSeq(input.parserAppliedSeq)
  const highestObservedSeq = Math.max(
    normalizeSeq(input.highestObservedSeq ?? input.lastSeq),
    parserAppliedSeq,
  )
  const surfaceSafeForDeltaReplay = input.surfaceSafeForDeltaReplay ?? knownLostRanges.length === 0
  const requiresSurfaceQuarantine = input.requiresSurfaceQuarantine ?? !surfaceSafeForDeltaReplay

  return {
    lastSeq: highestObservedSeq,
    highestObservedSeq,
    parserAppliedSeq,
    awaitingFreshSequence: Boolean(input.awaitingFreshSequence),
    pendingReplay: input.pendingReplay ?? null,
    knownLostRanges,
    surfaceSafeForDeltaReplay,
    requiresSurfaceQuarantine,
  }
}

function toGapDecision(state: AttachSeqState): OutputGapDecision {
  return {
    state,
    surfaceSafeForDeltaReplay: state.surfaceSafeForDeltaReplay,
    requiresSurfaceQuarantine: state.requiresSurfaceQuarantine,
  }
}

export function createAttachSeqState(input?: Partial<AttachSeqState>): AttachSeqState {
  return buildState(input ?? {})
}

export function beginAttach(state: AttachSeqState): AttachSeqState {
  return { ...createAttachSeqState(state), awaitingFreshSequence: true }
}

export function onAttachReady(
  state: AttachSeqState,
  ready: { headSeq: number; replayFromSeq: number; replayToSeq: number },
): AttachSeqState {
  const current = createAttachSeqState(state)
  const hasReplayWindow = ready.replayFromSeq > 0
    && ready.replayFromSeq <= ready.replayToSeq

  // Overlapping attaches (for example viewport hydrate + reconnect) can leave
  // a newer attach's high-water cursor in state before an older replay window arrives.
  // If we're still awaiting fresh attach data and the replay starts at/before
  // our cursor, rewind to replayFromSeq-1 so those replay frames are accepted.
  const shouldRewindCursorForReplay = hasReplayWindow
    && current.awaitingFreshSequence
    && ready.replayFromSeq <= current.highestObservedSeq
  const replayBaseline = shouldRewindCursorForReplay
    ? Math.max(0, ready.replayFromSeq - 1)
    : current.highestObservedSeq
  const replayAlreadyCovered = hasReplayWindow && ready.replayToSeq <= replayBaseline

  if (hasReplayWindow && !replayAlreadyCovered) {
    // Keep awaitingFreshSequence true until replay/live output is actually accepted.
    // attach.ready arrives before replay frames, so clearing it here is premature.
    return buildState({
      ...current,
      lastSeq: replayBaseline,
      highestObservedSeq: replayBaseline,
      parserAppliedSeq: Math.min(current.parserAppliedSeq, replayBaseline),
      pendingReplay: { fromSeq: ready.replayFromSeq, toSeq: ready.replayToSeq },
    })
  }
  return buildState({
    ...current,
    lastSeq: Math.max(replayBaseline, ready.headSeq),
    highestObservedSeq: Math.max(replayBaseline, ready.headSeq),
    awaitingFreshSequence: false,
    pendingReplay: null,
  })
}

export function onOutputGap(
  state: AttachSeqState,
  gap: { fromSeq: number; toSeq: number },
): OutputGapDecision {
  const current = createAttachSeqState(state)
  const fromSeq = normalizeSeq(gap.fromSeq)
  const toSeq = Math.max(fromSeq, normalizeSeq(gap.toSeq))
  const hasLostRange = toSeq > 0
  const nextHighestObservedSeq = Math.max(current.highestObservedSeq, toSeq)
  const shouldClearReplay = current.pendingReplay
    ? toSeq >= current.pendingReplay.toSeq
    : false
  const knownLostRanges = hasLostRange
    ? mergeLostRanges([...current.knownLostRanges, { fromSeq, toSeq }])
    : current.knownLostRanges

  return toGapDecision(buildState({
    ...current,
    lastSeq: nextHighestObservedSeq,
    highestObservedSeq: nextHighestObservedSeq,
    awaitingFreshSequence: false,
    pendingReplay: shouldClearReplay ? null : current.pendingReplay,
    knownLostRanges,
    surfaceSafeForDeltaReplay: hasLostRange ? false : current.surfaceSafeForDeltaReplay,
    requiresSurfaceQuarantine: hasLostRange || current.requiresSurfaceQuarantine,
  }))
}

export function onOutputFrame(
  state: AttachSeqState,
  frame: { seqStart: number; seqEnd: number },
): OutputFrameDecision {
  const current = createAttachSeqState(state)
  const seqStart = normalizeSeq(frame.seqStart)
  const seqEnd = Math.max(seqStart, normalizeSeq(frame.seqEnd))
  const shouldFreshReset =
    current.awaitingFreshSequence
    && seqStart === 1
    && current.highestObservedSeq > 0

  const effectiveState = shouldFreshReset
    ? buildState({
        ...current,
        lastSeq: 0,
        highestObservedSeq: 0,
        parserAppliedSeq: 0,
        pendingReplay: null,
        knownLostRanges: [],
        surfaceSafeForDeltaReplay: true,
        requiresSurfaceQuarantine: false,
      })
    : current

  const overlapsExisting = seqStart <= effectiveState.highestObservedSeq
  const offersNewData = seqEnd > effectiveState.highestObservedSeq
  // We treat any overlap with pendingReplay as replay-context data. Server stream-v2
  // currently emits per-sequence frames, so partial-range replays that would duplicate
  // already-rendered bytes are not expected in practice. This assumption is load-bearing
  // for overlap acceptance inside pending replay windows.
  const inPendingReplay = Boolean(
    effectiveState.pendingReplay
      && seqEnd >= effectiveState.pendingReplay.fromSeq
      && seqStart <= effectiveState.pendingReplay.toSeq,
  )
  const allowsReplayAdvance = inPendingReplay && offersNewData
  const isDuplicateOrStaleOverlap = overlapsExisting && !allowsReplayAdvance

  // Replay windows can legally overlap the current high-water mark. However, if a frame
  // is entirely at-or-below lastSeq, it is a duplicate and should still be dropped.
  if (isDuplicateOrStaleOverlap) {
    return { accept: false, reason: 'overlap' }
  }

  const nextHighestObservedSeq = Math.max(effectiveState.highestObservedSeq, seqEnd)
  const pendingReplay = effectiveState.pendingReplay && seqEnd >= effectiveState.pendingReplay.toSeq
    ? null
    : effectiveState.pendingReplay

  return {
    accept: true,
    freshReset: shouldFreshReset,
    state: buildState({
      ...effectiveState,
      lastSeq: nextHighestObservedSeq,
      highestObservedSeq: nextHighestObservedSeq,
      pendingReplay,
      awaitingFreshSequence: false,
    }),
  }
}

export function onOutputBatchSegments(
  state: AttachSeqState,
  segments: Array<{ seqStart: number; seqEnd: number }>,
): OutputBatchDecision {
  const initialState = createAttachSeqState(state)
  let current = initialState
  let freshReset = false
  const acceptedSegments: OutputBatchAcceptedSegment[] = []

  for (const segment of segments) {
    const previousState = current
    const decision = onOutputFrame(current, segment)
    if (!decision.accept) {
      return {
        accept: false,
        reason: decision.reason,
        rejectedSegment: {
          seqStart: normalizeSeq(segment.seqStart),
          seqEnd: Math.max(normalizeSeq(segment.seqStart), normalizeSeq(segment.seqEnd)),
        },
        state: initialState,
      }
    }
    freshReset = freshReset || decision.freshReset
    current = decision.state
    acceptedSegments.push({
      seqStart: normalizeSeq(segment.seqStart),
      seqEnd: Math.max(normalizeSeq(segment.seqStart), normalizeSeq(segment.seqEnd)),
      freshReset: decision.freshReset,
      parserAppliedSeq: decision.state.highestObservedSeq,
      previousState,
      state: decision.state,
    })
  }

  return {
    accept: true,
    freshReset,
    state: current,
    segments: acceptedSegments,
  }
}

export function markParserAppliedSeq(state: AttachSeqState, seq: number): AttachSeqState {
  const current = createAttachSeqState(state)
  let acknowledgedSeq = Math.min(normalizeSeq(seq), current.highestObservedSeq)
  for (const range of current.knownLostRanges) {
    if (range.toSeq <= current.parserAppliedSeq || acknowledgedSeq < range.fromSeq) {
      continue
    }
    if (range.fromSeq <= current.parserAppliedSeq) {
      acknowledgedSeq = current.parserAppliedSeq
      break
    }
    if (acknowledgedSeq >= range.fromSeq) {
      acknowledgedSeq = range.fromSeq - 1
      break
    }
  }
  if (acknowledgedSeq <= current.parserAppliedSeq) return current
  return buildState({
    ...current,
    parserAppliedSeq: acknowledgedSeq,
  })
}

export function markOutputRangeUnapplied(
  state: AttachSeqState,
  range: { fromSeq: number; toSeq: number },
): AttachSeqState {
  const current = createAttachSeqState(state)
  const fromSeq = normalizeSeq(range.fromSeq)
  const toSeq = Math.max(fromSeq, normalizeSeq(range.toSeq))
  if (toSeq <= 0) return current
  return buildState({
    ...current,
    knownLostRanges: mergeLostRanges([...current.knownLostRanges, { fromSeq, toSeq }]),
    surfaceSafeForDeltaReplay: false,
    requiresSurfaceQuarantine: true,
  })
}
