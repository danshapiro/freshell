export type PendingReplay = { fromSeq: number; toSeq: number } | null

export type OutputFrameDecision =
  | { accept: true; freshReset: boolean; state: AttachSeqState }
  | { accept: false; reason: 'overlap' }

export type AttachSeqState = {
  lastSeq: number
  awaitingFreshSequence: boolean
  pendingReplay: PendingReplay
}

export function createAttachSeqState(input?: Partial<AttachSeqState>): AttachSeqState {
  return {
    lastSeq: Math.max(0, Math.floor(input?.lastSeq ?? 0)),
    awaitingFreshSequence: Boolean(input?.awaitingFreshSequence),
    pendingReplay: input?.pendingReplay ?? null,
  }
}

export function beginAttach(state: AttachSeqState): AttachSeqState {
  return { ...state, awaitingFreshSequence: true }
}

export function onAttachReady(
  state: AttachSeqState,
  ready: { headSeq: number; replayFromSeq: number; replayToSeq: number },
): AttachSeqState {
  const hasReplayWindow = ready.replayFromSeq > 0
    && ready.replayFromSeq <= ready.replayToSeq

  // Overlapping attaches (for example viewport hydrate + reconnect) can leave
  // a newer attach's high-water cursor in state before an older replay window arrives.
  // If we're still awaiting fresh attach data and the replay starts at/before
  // our cursor, rewind to replayFromSeq-1 so those replay frames are accepted.
  const shouldRewindCursorForReplay = hasReplayWindow
    && state.awaitingFreshSequence
    && ready.replayFromSeq <= state.lastSeq
  const replayBaseline = shouldRewindCursorForReplay
    ? Math.max(0, ready.replayFromSeq - 1)
    : state.lastSeq
  const replayAlreadyCovered = hasReplayWindow && ready.replayToSeq <= replayBaseline

  if (hasReplayWindow && !replayAlreadyCovered) {
    // Keep awaitingFreshSequence true until replay/live output is actually accepted.
    // attach.ready arrives before replay frames, so clearing it here is premature.
    return {
      ...state,
      lastSeq: replayBaseline,
      pendingReplay: { fromSeq: ready.replayFromSeq, toSeq: ready.replayToSeq },
    }
  }
  return {
    ...state,
    lastSeq: Math.max(replayBaseline, ready.headSeq),
    awaitingFreshSequence: false,
    pendingReplay: null,
  }
}

export function onOutputGap(
  state: AttachSeqState,
  gap: { fromSeq: number; toSeq: number },
): AttachSeqState {
  const fromSeq = Math.max(0, Math.floor(gap.fromSeq))
  const toSeq = Math.max(fromSeq, Math.floor(gap.toSeq))
  const nextLastSeq = Math.max(state.lastSeq, toSeq)
  const shouldClearReplay = state.pendingReplay
    ? toSeq >= state.pendingReplay.toSeq
    : false
  return {
    ...state,
    lastSeq: nextLastSeq,
    awaitingFreshSequence: false,
    pendingReplay: shouldClearReplay ? null : state.pendingReplay,
  }
}

export function onOutputFrame(
  state: AttachSeqState,
  frame: { seqStart: number; seqEnd: number },
): OutputFrameDecision {
  const overlapsExisting = frame.seqStart <= state.lastSeq
  const offersNewData = frame.seqEnd > state.lastSeq
  // We treat any overlap with pendingReplay as replay-context data. Server stream-v2
  // currently emits per-sequence frames, so partial-range replays that would duplicate
  // already-rendered bytes are not expected in practice. This assumption is load-bearing
  // for overlap acceptance inside pending replay windows.
  const inPendingReplay = Boolean(
    state.pendingReplay
      && frame.seqEnd >= state.pendingReplay.fromSeq
      && frame.seqStart <= state.pendingReplay.toSeq,
  )
  const allowsReplayAdvance = inPendingReplay && offersNewData
  const isDuplicateOrStaleOverlap = overlapsExisting && !allowsReplayAdvance

  // Replay windows can legally overlap the current high-water mark. However, if a frame
  // is entirely at-or-below lastSeq, it is a duplicate and should still be dropped.
  if (isDuplicateOrStaleOverlap) {
    const freshReset =
      state.awaitingFreshSequence
      && frame.seqStart === 1
      && state.lastSeq > 0
    if (!freshReset) return { accept: false, reason: 'overlap' }
    // A fresh reset means we are treating this as a new stream root; any stale replay
    // window from the previous stream is intentionally discarded.
    const resetState = { ...state, lastSeq: 0, pendingReplay: null }
    // Bounded recursion: lastSeq resets to 0, so the follow-up call cannot hit
    // this overlap branch again for a seqStart=1 frame.
    const resetDecision = onOutputFrame(resetState, frame)
    if (!resetDecision.accept) return resetDecision
    return { ...resetDecision, freshReset: true }
  }

  const nextLastSeq = Math.max(state.lastSeq, frame.seqEnd)
  const pendingReplay = state.pendingReplay && frame.seqEnd >= state.pendingReplay.toSeq
    ? null
    : state.pendingReplay

  return {
    accept: true,
    freshReset: false,
    state: {
      ...state,
      lastSeq: nextLastSeq,
      pendingReplay,
      awaitingFreshSequence: false,
    },
  }
}
