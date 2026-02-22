import { describe, expect, it } from 'vitest'
import {
  createAttachSeqState,
  beginAttach,
  onAttachReady,
  onOutputFrame,
  onOutputGap,
} from '@/lib/terminal-attach-seq-state'

describe('terminal-attach-seq-state', () => {
  it('does not pre-advance lastSeq when replay window is pending', () => {
    const state = beginAttach(createAttachSeqState({ lastSeq: 0 }))
    const ready = onAttachReady(state, { replayFromSeq: 6, replayToSeq: 8 })
    expect(ready.lastSeq).toBe(0)
    expect(ready.pendingReplay).toEqual({ fromSeq: 6, toSeq: 8 })
  })

  it('accepts replay frames after ready when replay starts above 1', () => {
    let state = beginAttach(createAttachSeqState({ lastSeq: 0 }))
    state = onAttachReady(state, { replayFromSeq: 6, replayToSeq: 8 })
    const d6 = onOutputFrame(state, { seqStart: 6, seqEnd: 6 })
    expect(d6.accept).toBe(true)
    state = d6.state
    const d7 = onOutputFrame(state, { seqStart: 7, seqEnd: 7 })
    expect(d7.accept).toBe(true)
    state = d7.state
    const d8 = onOutputFrame(state, { seqStart: 8, seqEnd: 8 })
    expect(d8.accept).toBe(true)
    expect(d8.state.pendingReplay).toBeNull()
    expect(d8.state.lastSeq).toBe(8)
  })

  it('drops overlap outside pending replay window', () => {
    const state = createAttachSeqState({ lastSeq: 8 })
    const decision = onOutputFrame(state, { seqStart: 7, seqEnd: 8 })
    expect(decision.accept).toBe(false)
    expect(decision.reason).toBe('overlap')
  })

  it('advances through replay_window_exceeded gap and preserves forward progress', () => {
    let state = beginAttach(createAttachSeqState({ lastSeq: 0 }))
    state = onAttachReady(state, { replayFromSeq: 6, replayToSeq: 8 })
    state = onOutputGap(state, { fromSeq: 1, toSeq: 5 })
    const frame = onOutputFrame(state, { seqStart: 6, seqEnd: 8 })
    expect(frame.accept).toBe(true)
    expect(frame.state.lastSeq).toBe(8)
    expect(frame.state.pendingReplay).toBeNull()
  })

  it('allows single fresh restart at seq=1 while awaitingFreshSequence', () => {
    let state = createAttachSeqState({ lastSeq: 22, awaitingFreshSequence: true })
    const first = onOutputFrame(state, { seqStart: 1, seqEnd: 1 })
    expect(first.accept).toBe(true)
    expect(first.state.lastSeq).toBe(1)
    state = first.state
    const overlap = onOutputFrame(state, { seqStart: 1, seqEnd: 1 })
    expect(overlap.accept).toBe(false)
  })
})
