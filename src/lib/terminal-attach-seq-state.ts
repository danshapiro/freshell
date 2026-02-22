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
  return { ...state }
}

export function onAttachReady(
  state: AttachSeqState,
  _ready: { replayFromSeq: number; replayToSeq: number },
): AttachSeqState {
  return state
}

export function onOutputGap(
  state: AttachSeqState,
  _gap: { fromSeq: number; toSeq: number },
): AttachSeqState {
  return state
}

export function onOutputFrame(
  state: AttachSeqState,
  _frame: { seqStart: number; seqEnd: number },
): { accept: boolean; reason?: 'overlap'; state: AttachSeqState } {
  return {
    accept: true,
    state,
  }
}
