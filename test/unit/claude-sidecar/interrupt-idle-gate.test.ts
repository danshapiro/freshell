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

  // G03: the CLI ends a stopped turn with error_during_execution and an
  // `[ede_diagnostic]` error (T11). That is the user's own Stop, not a
  // failure, so no error frame (the client's "Agent error" banner) follows.
  it.each([
    { stage: 'streamed text', prompt: 'HANG', started: (frame: Record<string, any>) => frame.type === 'sdk.session.init' },
    {
      stage: 'a tool call',
      prompt: 'TOOL:sleep=30',
      started: (frame: Record<string, any>) => frame.type === 'sdk.assistant' && frame.content?.some((block: { type: string }) => block.type === 'tool_use'),
    },
  ])('a Stop during $stage ends the turn silently and with no error', async ({ prompt, started }) => {
    const bridge = await startRealSidecar()
    const sessionId = await createSession(bridge)

    bridge.send({ type: 'send', sessionId, text: prompt })
    await bridge.waitFor(started, `${prompt} under way`)
    bridge.send({ type: 'interrupt', sessionId })
    expect(await bridge.waitFor('sdk.interrupt_settled')).toMatchObject({ sessionId, ok: true })
    expect(await bridge.waitFor('sdk.result')).toMatchObject({ sessionId, result: 'error_during_execution' })

    // Everything the stopped turn produces has arrived once the next turn has
    // rung: it is still exactly one edge, and no error frame at all.
    bridge.send({ type: 'send', sessionId, text: 'after the stop' })
    await bridge.waitFor((frame) => frame.type === 'sdk.result' && frame.result === 'success', 'the next turn result')
    await bridge.waitFor('sdk.turn.complete')
    expect(bridge.frames.filter((frame) => frame.type === 'sdk.turn.complete')).toHaveLength(1)
    expect(bridge.frames.filter((frame) => frame.type === 'sdk.error')).toEqual([])
  })

  // G06: a Stop that reaches the CLI while it is still starting can miss the
  // turn. Its receipt comes back ok (either shape, T13) and the turn then runs
  // to success/completed. Only an aborted result is the stopped turn's own, so
  // this one rings: the user believes the turn stopped, and it did not.
  it.each(['empty', 'queued'])('a cold Stop the CLI never applied: the turn completes and rings (receipt shape %s)', async (receipt) => {
    const bridge = await startRealSidecar({ env: { FRESHELL_CLAUDE_SIM_COLD_STOP_RECEIPT: receipt } })
    const sessionId = await bridge.create({ requestId: 'create', model: 'opus' })
    // The CLI boots for T.boot (600 ms) after `created`; the send and the Stop
    // reach it before that, in one stdin chunk.
    expect(bridge.ledger().filter((row) => row.kind === 'boot')).toEqual([])
    bridge.sendLines([{ type: 'send', sessionId, text: 'hello' }, { type: 'interrupt', sessionId }])
    expect(await bridge.waitFor('sdk.interrupt_settled')).toMatchObject({ sessionId, ok: true })
    expect(await bridge.waitFor('sdk.result')).toMatchObject({ sessionId, result: 'success' })
    expect(await bridge.waitFor('sdk.turn.complete')).toMatchObject({ sessionId })
  })

  // A boot refusal (T5) is also error_during_execution with no
  // terminal_reason, but it ran no turn (num_turns 0): no Stop ended it. So a
  // Stop sent while the CLI was still starting does not hide it: the turn the
  // user sent never ran, which rings, and the refusal says why.
  it('a cold Stop during a refused resume boot still rings and shows the refusal', async () => {
    const bridge = await startRealSidecar()
    const missing = '0f5a2a8e-5a0c-4d6b-9a52-3c1f7f0d2b11'
    const sessionId = await bridge.create({ requestId: 'create', model: 'opus', resumeSessionId: missing })
    expect(bridge.ledger().filter((row) => row.kind === 'boot')).toEqual([])
    bridge.sendLines([{ type: 'send', sessionId, text: 'hello' }, { type: 'interrupt', sessionId }])

    expect(await bridge.waitFor('sdk.result')).toMatchObject({ sessionId, result: 'error_during_execution' })
    expect(await bridge.waitFor((frame) => frame.type === 'sdk.error' && frame.turnFailure === true, 'the refusal banner'))
      .toMatchObject({ sessionId, message: `No conversation found with session ID: ${missing}` })
    expect(await bridge.waitFor('sdk.turn.complete')).toMatchObject({ sessionId })
  })

  it('a stale Stop mark never swallows the next turn\'s bell', async () => {
    const bridge = await startRealSidecar()
    const sessionId = await createSession(bridge)

    // A send pushed during a tool call is absorbed into that turn (T10): two
    // sends, one result. The sidecar still counts the absorbed send as owed.
    bridge.send({ type: 'send', sessionId, text: 'TOOL:sleep=1' })
    await bridge.waitFor((frame) => frame.type === 'sdk.assistant' && frame.content?.some((block: { type: string }) => block.type === 'tool_use'), 'the tool call')
    bridge.send({ type: 'send', sessionId, text: 'absorbed into the tool turn' })
    await bridge.waitForPrompt(2)
    expect(await bridge.waitFor('sdk.result')).toMatchObject({ sessionId, result: 'success' })
    await bridge.waitFor('sdk.turn.complete')

    // A Stop now finds the CLI idle, but the owed absorbed send arms a mark,
    // and nothing the Stop could abort follows it.
    bridge.send({ type: 'interrupt', sessionId })
    expect(await bridge.waitFor('sdk.interrupt_settled')).toMatchObject({ sessionId, ok: true })

    // The next turn completes normally: it rings.
    bridge.send({ type: 'send', sessionId, text: 'the next turn' })
    await bridge.waitFor(() => bridge.frames.filter((frame) => frame.type === 'sdk.result').length === 2, 'the next turn result')
    await bridge.waitFor(() => bridge.frames.filter((frame) => frame.type === 'sdk.turn.complete').length === 2, 'the next turn rings')
    expect(bridge.frames.filter((frame) => frame.type === 'sdk.result').map((frame) => frame.result)).toEqual(['success', 'success'])
  })

  it('a Stop that missed the turn does not silence a turn that then ends with no result', async () => {
    const bridge = await startRealSidecar({
      program: { rules: [{ on: 'msg:prompt', match: { text: 'CRASH_SOON' }, emit: [{ kind: 'crash', delayMs: 300 }] }] },
    })
    const sessionId = await bridge.create({ requestId: 'create', model: 'opus' })
    expect(bridge.ledger().filter((row) => row.kind === 'boot')).toEqual([])
    // A cold Stop: it overtakes the send, so the turn runs; then the CLI dies
    // mid-turn and the stream ends with no result (T14).
    bridge.sendLines([{ type: 'send', sessionId, text: 'CRASH_SOON' }, { type: 'interrupt', sessionId }])
    expect(await bridge.waitFor('sdk.interrupt_settled')).toMatchObject({ sessionId, ok: true })
    await bridge.waitForPrompt(1)
    expect(await bridge.waitFor('sdk.error')).toMatchObject({ sessionId })
    expect(await bridge.waitFor('sdk.turn.complete')).toMatchObject({ sessionId })
    expect(bridge.frames.filter((frame) => frame.type === 'sdk.result')).toEqual([])
  })
})
