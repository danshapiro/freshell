import { describe, expect, it } from 'vitest'
import { nextMonotonicStatusSeq, nextMonotonicTurnCompleteAt } from '../../../../server/fresh-agent/turn-complete-clock.js'

describe('nextMonotonicTurnCompleteAt', () => {
  it('uses the wall clock for the first completion of a session', () => {
    expect(nextMonotonicTurnCompleteAt(undefined, 1000)).toBe(1000)
  })

  it('uses the wall clock when it has advanced past the previous completion', () => {
    expect(nextMonotonicTurnCompleteAt(1000, 1500)).toBe(1500)
  })

  it('breaks a same-millisecond tie so two distinct turns never collide', () => {
    // Two genuine completions stamped in the same Date.now() millisecond must remain
    // distinguishable, otherwise the client at<=last dedupe would swallow the second.
    expect(nextMonotonicTurnCompleteAt(1000, 1000)).toBe(1001)
  })

  it('never regresses when the system clock steps backwards', () => {
    // A backward clock step (NTP correction) must not make a real later completion look
    // like a stale replay.
    expect(nextMonotonicTurnCompleteAt(2000, 1500)).toBe(2001)
  })
})

describe('nextMonotonicStatusSeq', () => {
  // The provider-agnostic statusSeq shares the turn-complete wall-clock-ms regime:
  // strictly monotonic per session via the same now<=last ? last+1 : now clamp.
  it('uses the wall clock for the first tracked status of a session', () => {
    expect(nextMonotonicStatusSeq(undefined, 1000)).toBe(1000)
  })

  it('uses the wall clock when it has advanced past the previous seq', () => {
    expect(nextMonotonicStatusSeq(1000, 1500)).toBe(1500)
  })

  it('breaks a same-millisecond tie so two distinct status edges never collide', () => {
    // Two status transitions stamped in the same Date.now() millisecond must remain
    // ordered, otherwise the client statusSeq<=last gate would drop the second as stale.
    expect(nextMonotonicStatusSeq(1000, 1000)).toBe(1001)
  })

  it('never regresses when the system clock steps backwards', () => {
    // A backward clock step (NTP correction) must not make a real later status look
    // like a stale frame to the client gate.
    expect(nextMonotonicStatusSeq(2000, 1500)).toBe(2001)
  })
})
