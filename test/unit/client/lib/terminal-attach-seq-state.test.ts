import { describe, expect, it } from 'vitest'
import {
  createAttachSeqState,
  beginAttach,
  markOutputRangeUnapplied,
  markParserAppliedSeq,
  onAttachReady,
  onOutputBatchSegments,
  onOutputFrame,
  onOutputGap,
} from '@/lib/terminal-attach-seq-state'

function expectAcceptedFrame(decision: ReturnType<typeof onOutputFrame>) {
  expect(decision.accept).toBe(true)
  if (!decision.accept) throw new Error('expected accepted frame decision')
  return decision
}

describe('terminal-attach-seq-state', () => {
  it('does not pre-advance lastSeq when replay window is pending', () => {
    const state = beginAttach(createAttachSeqState({ lastSeq: 0 }))
    const ready = onAttachReady(state, { headSeq: 8, replayFromSeq: 6, replayToSeq: 8 })
    expect(ready.lastSeq).toBe(0)
    expect(ready.pendingReplay).toEqual({ fromSeq: 6, toSeq: 8 })
  })

  it('treats replay 0..0 as no replay window', () => {
    const state = beginAttach(createAttachSeqState({ lastSeq: 4 }))
    const ready = onAttachReady(state, { headSeq: 7, replayFromSeq: 0, replayToSeq: 0 })
    expect(ready.pendingReplay).toBeNull()
    expect(ready.lastSeq).toBe(7)
    expect(ready.awaitingFreshSequence).toBe(false)
  })

  it('takes the no-replay branch when replayFromSeq is above replayToSeq', () => {
    const state = beginAttach(createAttachSeqState({ lastSeq: 4 }))
    const ready = onAttachReady(state, { headSeq: 7, replayFromSeq: 8, replayToSeq: 7 })
    expect(ready.pendingReplay).toBeNull()
    expect(ready.lastSeq).toBe(7)
    expect(ready.awaitingFreshSequence).toBe(false)
  })

  it('skips replay window already covered by local cursor when not awaiting a fresh attach', () => {
    const state = createAttachSeqState({ lastSeq: 10, awaitingFreshSequence: false })
    const ready = onAttachReady(state, { headSeq: 10, replayFromSeq: 6, replayToSeq: 8 })
    expect(ready.pendingReplay).toBeNull()
    expect(ready.lastSeq).toBe(10)
    expect(ready.awaitingFreshSequence).toBe(false)
  })

  it('rewinds cursor when an attach replay window starts below the current cursor', () => {
    const state = beginAttach(createAttachSeqState({ lastSeq: 10 }))
    const ready = onAttachReady(state, { headSeq: 10, replayFromSeq: 6, replayToSeq: 8 })
    expect(ready.lastSeq).toBe(5)
    expect(ready.pendingReplay).toEqual({ fromSeq: 6, toSeq: 8 })

    const frame = expectAcceptedFrame(onOutputFrame(ready, { seqStart: 6, seqEnd: 6 }))
    expect(frame.state.lastSeq).toBe(6)
    expect(frame.state.pendingReplay).toEqual({ fromSeq: 6, toSeq: 8 })
  })

  it('accepts replay frames after ready when replay starts above 1', () => {
    let state = beginAttach(createAttachSeqState({ lastSeq: 0 }))
    state = onAttachReady(state, { headSeq: 8, replayFromSeq: 6, replayToSeq: 8 })
    const d6 = expectAcceptedFrame(onOutputFrame(state, { seqStart: 6, seqEnd: 6 }))
    expect(d6.freshReset).toBe(false)
    state = d6.state
    const d7 = expectAcceptedFrame(onOutputFrame(state, { seqStart: 7, seqEnd: 7 }))
    state = d7.state
    const d8 = expectAcceptedFrame(onOutputFrame(state, { seqStart: 8, seqEnd: 8 }))
    expect(d8.state.pendingReplay).toBeNull()
    expect(d8.state.lastSeq).toBe(8)
  })

  it('drops duplicate frames already consumed inside a pending replay window', () => {
    let state = beginAttach(createAttachSeqState({ lastSeq: 0 }))
    state = onAttachReady(state, { headSeq: 8, replayFromSeq: 6, replayToSeq: 8 })

    const first = expectAcceptedFrame(onOutputFrame(state, { seqStart: 6, seqEnd: 6 }))
    state = first.state

    const duplicate = onOutputFrame(state, { seqStart: 6, seqEnd: 6 })
    expect(duplicate.accept).toBe(false)
    expect(duplicate.reason).toBe('overlap')
  })

  it('accepts merged frames that overlap pending replay when they advance lastSeq', () => {
    let state = beginAttach(createAttachSeqState({ lastSeq: 0 }))
    state = onAttachReady(state, { headSeq: 12, replayFromSeq: 8, replayToSeq: 10 })

    const decision = onOutputFrame(state, { seqStart: 8, seqEnd: 11 })
    expect(decision.accept).toBe(true)
    if (decision.accept) {
      expect(decision.state.lastSeq).toBe(11)
    }
  })

  it('accepts all batch segments as one preflight decision', () => {
    let state = beginAttach(createAttachSeqState({ lastSeq: 0 }))
    state = onAttachReady(state, { headSeq: 8, replayFromSeq: 6, replayToSeq: 8 })

    const decision = onOutputBatchSegments(state, [
      { seqStart: 6, seqEnd: 6 },
      { seqStart: 7, seqEnd: 7 },
      { seqStart: 8, seqEnd: 8 },
    ])

    expect(decision.accept).toBe(true)
    if (!decision.accept) throw new Error('expected accepted batch decision')
    expect(decision.state.lastSeq).toBe(8)
    expect(decision.state.pendingReplay).toBeNull()
    expect(decision.segments.map((segment) => segment.parserAppliedSeq)).toEqual([6, 7, 8])
  })

  it('rejects an entire batch when any segment overlaps already accepted output', () => {
    const state = createAttachSeqState({ lastSeq: 2 })

    const decision = onOutputBatchSegments(state, [
      { seqStart: 3, seqEnd: 3 },
      { seqStart: 2, seqEnd: 2 },
      { seqStart: 4, seqEnd: 4 },
    ])

    expect(decision.accept).toBe(false)
    if (decision.accept) throw new Error('expected rejected batch decision')
    expect(decision.reason).toBe('overlap')
    expect(decision.rejectedSegment).toEqual({ seqStart: 2, seqEnd: 2 })
    expect(decision.state).toEqual(state)
  })

  it('drops overlap outside pending replay window', () => {
    const state = createAttachSeqState({ lastSeq: 8 })
    const decision = onOutputFrame(state, { seqStart: 7, seqEnd: 8 })
    expect(decision.accept).toBe(false)
    expect(decision.reason).toBe('overlap')
  })

  it('advances through replay_window_exceeded gap and preserves forward progress', () => {
    let state = beginAttach(createAttachSeqState({ lastSeq: 0 }))
    state = onAttachReady(state, { headSeq: 8, replayFromSeq: 6, replayToSeq: 8 })
    state = onOutputGap(state, { fromSeq: 1, toSeq: 5 }).state
    const frame = expectAcceptedFrame(onOutputFrame(state, { seqStart: 6, seqEnd: 8 }))
    expect(frame.freshReset).toBe(false)
    expect(frame.state.lastSeq).toBe(8)
    expect(frame.state.pendingReplay).toBeNull()
  })

  it('clears pending replay when a gap covers replay tail', () => {
    let state = beginAttach(createAttachSeqState({ lastSeq: 0 }))
    state = onAttachReady(state, { headSeq: 8, replayFromSeq: 6, replayToSeq: 8 })
    state = onOutputGap(state, { fromSeq: 1, toSeq: 8 }).state
    expect(state.lastSeq).toBe(8)
    expect(state.pendingReplay).toBeNull()
    expect(state.awaitingFreshSequence).toBe(false)
  })

  it('sanitizes negative gap ranges before applying cursor updates', () => {
    const state = createAttachSeqState({
      lastSeq: 3,
      pendingReplay: { fromSeq: 4, toSeq: 6 },
      awaitingFreshSequence: true,
    })
    const next = onOutputGap(state, { fromSeq: -5, toSeq: -1 }).state
    expect(next.lastSeq).toBe(3)
    expect(next.pendingReplay).toEqual({ fromSeq: 4, toSeq: 6 })
    expect(next.awaitingFreshSequence).toBe(false)
  })

  it('records gaps without advancing the parser-applied sequence', () => {
    const state = createAttachSeqState()
    const afterFrame = onOutputFrame(state, { seqStart: 1, seqEnd: 1 })
    expect(afterFrame.accept).toBe(true)
    if (!afterFrame.accept) throw new Error('expected accepted frame decision')

    const afterGap = onOutputGap(afterFrame.state, { fromSeq: 2, toSeq: 10 })

    expect(afterFrame.state.highestObservedSeq).toBe(1)
    expect(afterFrame.state.parserAppliedSeq).toBe(0)
    expect(afterGap.state.highestObservedSeq).toBe(10)
    expect(afterGap.state.parserAppliedSeq).toBe(0)
    expect(afterGap.state.knownLostRanges).toEqual([{ fromSeq: 2, toSeq: 10 }])
    expect(afterGap.surfaceSafeForDeltaReplay).toBe(false)
    expect(afterGap.requiresSurfaceQuarantine).toBe(true)
    expect('lastSeq' in afterGap).toBe(false)
    expect('parserAppliedSeq' in afterGap).toBe(false)
  })

  it('marks parser-applied output only after xterm acknowledgement', () => {
    const frame = expectAcceptedFrame(onOutputFrame(createAttachSeqState(), {
      seqStart: 1,
      seqEnd: 3,
    }))

    const appliedToTwo = markParserAppliedSeq(frame.state, 2)
    expect(appliedToTwo.parserAppliedSeq).toBe(2)
    expect(appliedToTwo.highestObservedSeq).toBe(3)

    const notDecreased = markParserAppliedSeq(appliedToTwo, 1)
    expect(notDecreased.parserAppliedSeq).toBe(2)

    const cappedAtObserved = markParserAppliedSeq(appliedToTwo, 9)
    expect(cappedAtObserved.parserAppliedSeq).toBe(3)
  })

  it('does not mark parser-applied output across a known lost range', () => {
    const frame = expectAcceptedFrame(onOutputFrame(createAttachSeqState(), {
      seqStart: 1,
      seqEnd: 1,
    }))
    const applied = markParserAppliedSeq(frame.state, 1)
    const gap = onOutputGap(applied, { fromSeq: 2, toSeq: 10 })

    expect(markParserAppliedSeq(gap.state, 10).parserAppliedSeq).toBe(1)
  })

  it('does not mark parser-applied output through the tail of an overlapping known lost range', () => {
    const frame = expectAcceptedFrame(onOutputFrame(createAttachSeqState(), {
      seqStart: 1,
      seqEnd: 12,
    }))
    const applied = markParserAppliedSeq(frame.state, 10)
    const gap = onOutputGap(applied, { fromSeq: 9, toSeq: 11 })

    const afterTail = markParserAppliedSeq(gap.state, 12)

    expect(gap.state.knownLostRanges).toEqual([{ fromSeq: 9, toSeq: 11 }])
    expect(afterTail.parserAppliedSeq).toBe(10)
    expect(afterTail.highestObservedSeq).toBe(12)
  })

  it('does not mark parser-applied output across an unapplied output range', () => {
    const accepted = expectAcceptedFrame(onOutputFrame(createAttachSeqState(), {
      seqStart: 1,
      seqEnd: 3,
    }))
    const withUnappliedRange = markOutputRangeUnapplied(accepted.state, {
      fromSeq: 2,
      toSeq: 2,
    })

    const applied = markParserAppliedSeq(withUnappliedRange, 3)

    expect(withUnappliedRange.knownLostRanges).toEqual([{ fromSeq: 2, toSeq: 2 }])
    expect(withUnappliedRange.surfaceSafeForDeltaReplay).toBe(false)
    expect(applied.parserAppliedSeq).toBe(1)
  })

  it('allows single fresh restart at seq=1 while awaitingFreshSequence', () => {
    let state = createAttachSeqState({ lastSeq: 22, awaitingFreshSequence: true })
    const first = expectAcceptedFrame(onOutputFrame(state, { seqStart: 1, seqEnd: 1 }))
    expect(first.freshReset).toBe(true)
    expect(first.state.lastSeq).toBe(1)
    state = first.state
    const overlap = onOutputFrame(state, { seqStart: 1, seqEnd: 1 })
    expect(overlap.accept).toBe(false)
  })
})
