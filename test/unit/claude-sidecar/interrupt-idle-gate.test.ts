// @vitest-environment node

// Real-sidecar behavioral pin for the unified attention gate's ARM condition
// (task-004 review F-I1), driven through the production index.mjs process
// over the CLI simulator (harness.ts): the interrupt mark is armed ONLY while
// a turn is plausibly awaiting a terminal frame (pendingResults > 0). The SDK
// contract documents RESOLUTION — not rejection — for interrupting with
// nothing in flight (sdk.d.ts:2384-2394), so an idle-session interrupt (a
// late Stop click racing the busy-clear, or a double-click second Stop) must
// arm NOTHING: the settle lands ok:true with no result to consume, and the
// NEXT unrelated turn ring survives. An interrupt while a turn IS pending
// still suppresses exactly the interrupted turn own result.

import { describe, expect, it } from 'vitest'
import { startRealSidecar, type RealSidecar } from './harness'

/** A booted session with nothing in flight (the CLI reports no init until a prompt, T1). */
async function createSession(bridge: RealSidecar) {
  const sessionId = await bridge.create({ requestId: 'create', model: 'opus' })
  await bridge.waitForBoot()
  return sessionId
}

describe('Claude sidecar interrupt gate arming (unified attention edge)', () => {
  it('an interrupt on an idle session settles ok:true and the next unrelated turn ring survives', async () => {
    const bridge = await startRealSidecar()
    const sessionId = await createSession(bridge)

    // Idle-session interrupt: nothing awaits a terminal frame. The CLI
    // RESOLVES interrupt() (the documented nothing-in-flight contract), so
    // the settle lands ok:true — and NO mark may be armed. Pre-fix, the
    // unconditional arm here left a stray mark that consumed exactly the
    // next result ring, silently suppressing an attention edge the user
    // never witnessed.
    bridge.send({ type: 'interrupt', sessionId })
    expect(await bridge.waitFor('sdk.interrupt_settled')).toMatchObject({ sessionId, ok: true })

    // The NEXT unrelated turn result must still ring.
    bridge.send({ type: 'send', sessionId, text: 'next unrelated turn' })
    expect(await bridge.waitFor('sdk.result')).toMatchObject({ sessionId, result: 'success' })
    expect(await bridge.waitFor('sdk.turn.complete')).toMatchObject({ sessionId })
  })

  it('an interrupt while a turn is pending suppresses exactly that turn result; the next turn rings again', async () => {
    const bridge = await startRealSidecar()
    const sessionId = await createSession(bridge)

    // A turn whose model request never completes (HANG) until the interrupt
    // aborts it: the interrupted turn's own terminal frame lands AFTER the
    // settle receipt (the SDK ordering the gate depends on, sdk.d.ts:3765;
    // T11). The interrupt goes out once the turn has started (its init, T1),
    // so it is a warm Stop, not a cold one racing the CLI's boot (T13).
    bridge.send({ type: 'send', sessionId, text: 'HANG' })
    await bridge.waitFor('sdk.session.init')
    bridge.send({ type: 'interrupt', sessionId })
    expect(await bridge.waitFor('sdk.interrupt_settled')).toMatchObject({ sessionId, ok: true })
    expect(await bridge.waitFor('sdk.result')).toMatchObject({ sessionId, result: 'error_during_execution' })

    // The next turn rings again — and by then exactly ONE edge has landed:
    // the interrupted turn own ring was consumed by the armed mark.
    bridge.send({ type: 'send', sessionId, text: 'after interrupt' })
    expect(await bridge.waitFor('sdk.turn.complete')).toMatchObject({ sessionId })
    expect(bridge.frames.filter((frame) => frame.type === 'sdk.turn.complete')).toHaveLength(1)
  })
})
