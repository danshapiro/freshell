import { describe, expect, it } from 'vitest'
import {
  createAttachSeqState,
  beginAttach,
  onAttachReady,
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

  it('skips replay window already covered by local cursor', () => {
    const state = beginAttach(createAttachSeqState({ lastSeq: 10 }))
    const ready = onAttachReady(state, { headSeq: 10, replayFromSeq: 6, replayToSeq: 8 })
    expect(ready.pendingReplay).toBeNull()
    expect(ready.lastSeq).toBe(10)
    expect(ready.awaitingFreshSequence).toBe(false)
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

  it('drops overlap outside pending replay window', () => {
    const state = createAttachSeqState({ lastSeq: 8 })
    const decision = onOutputFrame(state, { seqStart: 7, seqEnd: 8 })
    expect(decision.accept).toBe(false)
    expect(decision.reason).toBe('overlap')
  })

  it('advances through replay_window_exceeded gap and preserves forward progress', () => {
    let state = beginAttach(createAttachSeqState({ lastSeq: 0 }))
    state = onAttachReady(state, { headSeq: 8, replayFromSeq: 6, replayToSeq: 8 })
    state = onOutputGap(state, { fromSeq: 1, toSeq: 5 })
    const frame = expectAcceptedFrame(onOutputFrame(state, { seqStart: 6, seqEnd: 8 }))
    expect(frame.freshReset).toBe(false)
    expect(frame.state.lastSeq).toBe(8)
    expect(frame.state.pendingReplay).toBeNull()
  })

  it('clears pending replay when a gap covers replay tail', () => {
    let state = beginAttach(createAttachSeqState({ lastSeq: 0 }))
    state = onAttachReady(state, { headSeq: 8, replayFromSeq: 6, replayToSeq: 8 })
    state = onOutputGap(state, { fromSeq: 1, toSeq: 8 })
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
    const next = onOutputGap(state, { fromSeq: -5, toSeq: -1 })
    expect(next.lastSeq).toBe(3)
    expect(next.pendingReplay).toEqual({ fromSeq: 4, toSeq: 6 })
    expect(next.awaitingFreshSequence).toBe(false)
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
