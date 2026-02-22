export type PendingReplay = { fromSeq: number; toSeq: number } | null

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
  ready: { replayFromSeq: number; replayToSeq: number },
): AttachSeqState {
  const hasReplayWindow = ready.replayFromSeq > 0
    && ready.replayFromSeq <= ready.replayToSeq

  if (hasReplayWindow) {
    // Keep awaitingFreshSequence true until replay/live output is actually accepted.
    // attach.ready arrives before replay frames, so clearing it here is premature.
    return {
      ...state,
      pendingReplay: { fromSeq: ready.replayFromSeq, toSeq: ready.replayToSeq },
    }
  }
  return {
    ...state,
    lastSeq: Math.max(state.lastSeq, ready.replayToSeq),
    awaitingFreshSequence: false,
    pendingReplay: null,
  }
}

export function onOutputGap(
  state: AttachSeqState,
  gap: { fromSeq: number; toSeq: number },
): AttachSeqState {
  const nextLastSeq = Math.max(state.lastSeq, gap.toSeq)
  const shouldClearReplay = state.pendingReplay
    ? gap.toSeq >= state.pendingReplay.toSeq
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
): { accept: boolean; reason?: 'overlap'; state: AttachSeqState } {
  const overlapsExisting = frame.seqStart <= state.lastSeq
  const offersNewData = frame.seqEnd > state.lastSeq
  const inPendingReplay = Boolean(
    state.pendingReplay
      && frame.seqEnd >= state.pendingReplay.fromSeq
      && frame.seqStart <= state.pendingReplay.toSeq,
  )

  // Replay windows can legally overlap the current high-water mark. However, if a frame
  // is entirely at-or-below lastSeq, it is a duplicate and should still be dropped.
  if (overlapsExisting && (!inPendingReplay || !offersNewData)) {
    const freshReset =
      state.awaitingFreshSequence
      && frame.seqStart === 1
      && state.lastSeq > 0
    if (!freshReset) return { accept: false, reason: 'overlap', state }
    // A fresh reset means we are treating this as a new stream root; any stale replay
    // window from the previous stream is intentionally discarded.
    const resetState = { ...state, lastSeq: 0, pendingReplay: null }
    return onOutputFrame(resetState, frame)
  }

  const nextLastSeq = Math.max(state.lastSeq, frame.seqEnd)
  const pendingReplay = state.pendingReplay && frame.seqEnd >= state.pendingReplay.toSeq
    ? null
    : state.pendingReplay

  return {
    accept: true,
    state: {
      ...state,
      lastSeq: nextLastSeq,
      pendingReplay,
      awaitingFreshSequence: false,
    },
  }
}
