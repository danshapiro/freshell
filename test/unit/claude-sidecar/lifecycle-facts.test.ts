// @vitest-environment node
//
// uuid-stamped sends and the lifecycle facts the sidecar forwards (core-runtime
// design §5.1, C16), through the real index.mjs over the CLI simulator
// (harness.ts). Every send carries the uuid the server minted; the CLI keeps it
// for the command and the user line, and reports the command's lifecycle under
// it (T8). The sidecar forwards those facts, the session state (T9), status
// ends (T15), heartbeats (T17), interrupt receipts (T12) and each result's
// verdict facts, so the server can own turn accounting. Until the server's
// turn ledger takes over (C17/C18) the sidecar still emits its own
// turn.complete per result.

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { startRealSidecar, type RealSidecar, type SidecarFrame } from './harness'

/** A booted session with nothing in flight. */
async function session(options: Parameters<typeof startRealSidecar>[0] = {}) {
  const bridge = await startRealSidecar(options)
  const sessionId = await bridge.create({ requestId: 'create', model: 'opus' })
  await bridge.waitForBoot()
  return { bridge, sessionId }
}

function commandStates(bridge: RealSidecar, uuid: string): string[] {
  return bridge.frames.filter((frame) => frame.type === 'sdk.command' && frame.uuid === uuid).map((frame) => frame.state)
}

const isResult = (frame: SidecarFrame) => frame.type === 'sdk.result'

describe('uuid-stamped sends', () => {
  it('the CLI runs each send under the uuid the server gave it', async () => {
    const { bridge, sessionId } = await session()
    const uuid = randomUUID()
    bridge.send({ type: 'send', sessionId, uuid, text: 'hello' })
    expect(await bridge.waitForPrompt(1)).toMatchObject({ uuid, text: 'hello' })
  })

  it('forwards the sent command\'s lifecycle in the CLI\'s order, with its first replay', async () => {
    const { bridge, sessionId } = await session()
    const uuid = randomUUID()
    bridge.send({ type: 'send', sessionId, uuid, text: 'hello' })
    await bridge.waitFor((frame) => frame.type === 'sdk.command' && frame.uuid === uuid && frame.state === 'completed', 'the completed lifecycle')
    expect(commandStates(bridge, uuid)).toEqual(['queued', 'started', 'replayed', 'completed'])
    expect(bridge.frames.find((frame) => frame.type === 'sdk.command')).toMatchObject({ sessionId })
    // The result comes before the command's own end (T8).
    const result = bridge.frames.findIndex(isResult)
    const completed = bridge.frames.findIndex((frame) => frame.type === 'sdk.command' && frame.state === 'completed')
    expect(result).toBeGreaterThan(-1)
    expect(result).toBeLessThan(completed)
    // Staging rule: the sidecar's own edge is still sent until the server mints it (C18).
    expect(await bridge.waitFor('sdk.turn.complete')).toMatchObject({ sessionId })
  })

  it('forwards no lifecycle for commands the CLI makes itself', async () => {
    const { bridge, sessionId } = await session()
    // setModel runs /model inside the CLI and replays it under a uuid of its own (T8).
    bridge.send({ type: 'configure', sessionId, requestId: 'model', settings: { model: 'sonnet' } })
    expect(await bridge.waitFor('sdk.configured')).toMatchObject({ ok: true })
    const uuid = randomUUID()
    bridge.send({ type: 'send', sessionId, uuid, text: 'hello' })
    await bridge.waitFor((frame) => frame.type === 'sdk.command' && frame.state === 'completed', 'the completed lifecycle')
    expect(new Set(bridge.frames.filter((frame) => frame.type === 'sdk.command').map((frame) => frame.uuid))).toEqual(new Set([uuid]))
  })

  it('a checkpointed send binds its turn identity under the send\'s own uuid', async () => {
    const { bridge, sessionId } = await session()
    const uuid = randomUUID()
    bridge.send({ type: 'send', sessionId, uuid, text: 'hello', checkpointAttempt: { logicalAttemptId: 'attempt-1', requestId: 'send-1' } })
    expect(await bridge.waitFor('sdk.checkpointTurnIdentity')).toMatchObject({
      sessionId, logicalAttemptId: 'attempt-1', requestId: 'send-1', nativeTurnId: uuid, displayTurnId: uuid,
    })
  })
})

describe('session facts', () => {
  it('reports the session running and then idle around a turn (the sidecar turns the CLI\'s state events on)', async () => {
    const { bridge, sessionId } = await session()
    const query = bridge.ledger().find((row) => row.kind === 'query')
    expect(query?.options.envKeys).toContain('CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS')
    bridge.send({ type: 'send', sessionId, text: 'hello' })
    await bridge.waitFor((frame) => frame.type === 'sdk.session.state' && frame.state === 'idle', 'the idle state')
    const states = bridge.frames.filter((frame) => frame.type === 'sdk.session.state')
    expect(states.map((frame) => frame.state)).toEqual(['running', 'idle'])
    expect(states[0]).toMatchObject({ sessionId })
    // The idle arrives once the turn's result is in.
    expect(bridge.frames.findIndex(isResult)).toBeLessThan(bridge.frames.indexOf(states[1]))
  })

  it('reports each model request, and the end of a compaction with its outcome', async () => {
    const { bridge, sessionId } = await session()
    bridge.send({ type: 'send', sessionId, text: 'hello' })
    expect(await bridge.waitFor((frame) => frame.type === 'sdk.status' && frame.status === 'requesting', 'a request')).toEqual({ type: 'sdk.status', sessionId, status: 'requesting' })
    await bridge.waitFor(isResult, 'the first result')
    bridge.send({ type: 'send', sessionId, text: '/compact' })
    await bridge.waitFor((frame) => frame.type === 'sdk.status' && frame.status === 'compacting', 'compacting')
    expect(await bridge.waitFor((frame) => frame.type === 'sdk.status' && frame.status === null, 'the compaction\'s end'))
      .toEqual({ type: 'sdk.status', sessionId, status: null, compactResult: 'success' })
  })

  it('turns tool and task progress into heartbeats, at most one of each kind per five seconds', async () => {
    // A 100 s Bash call at 1/1000 speed: the CLI promotes it to a background
    // task after 3 s and heartbeats at 30, 60 and 90 s, all within 0.1 s of
    // real time.
    const { bridge, sessionId } = await session({ timeScale: 0.001 })
    bridge.send({ type: 'send', sessionId, text: 'TOOL:sleep=100' })
    await bridge.waitFor(isResult, 'the result')
    const toolUse = bridge.frames
      .filter((frame) => frame.type === 'sdk.assistant')
      .flatMap((frame) => frame.content)
      .find((block: { type: string }) => block.type === 'tool_use')
    const beats = bridge.frames.filter((frame) => frame.type === 'sdk.heartbeat')
    expect(beats.filter((beat) => beat.kind === 'tool')).toEqual([{ type: 'sdk.heartbeat', sessionId, kind: 'tool', toolUseId: toolUse.id, elapsedMs: 30_000 }])
    expect(beats.filter((beat) => beat.kind === 'task')).toEqual([{ type: 'sdk.heartbeat', sessionId, kind: 'task', toolUseId: toolUse.id }])
  })

  it('a Stop\'s receipt lists the sent command that will still run (T12)', async () => {
    const { bridge, sessionId } = await session()
    const running = randomUUID()
    const queued = randomUUID()
    bridge.send({ type: 'send', sessionId, uuid: running, text: 'HANG' })
    await bridge.waitFor('sdk.session.init')
    // A send during streamed text queues as its own turn (T10).
    bridge.send({ type: 'send', sessionId, uuid: queued, text: 'next' })
    await bridge.waitFor((frame) => frame.type === 'sdk.command' && frame.uuid === queued && frame.state === 'queued', 'the queued send')
    bridge.send({ type: 'interrupt', sessionId })
    expect(await bridge.waitFor('sdk.interrupt_settled')).toEqual({ type: 'sdk.interrupt_settled', sessionId, ok: true, stillQueued: [queued] })
    // The stopped command ends cancelled; the survivor runs as its own turn.
    await bridge.waitFor((frame) => frame.type === 'sdk.command' && frame.uuid === queued && frame.state === 'completed', 'the survivor completed')
    expect(commandStates(bridge, running)).toEqual(['queued', 'started', 'replayed', 'cancelled'])
  })

  it('each result carries its verdict facts', async () => {
    const { bridge, sessionId } = await session()
    bridge.send({ type: 'send', sessionId, text: 'hello' })
    expect(await bridge.waitFor(isResult, 'the result')).toMatchObject({
      sessionId, result: 'success', subtype: 'success', isError: false, terminalReason: 'completed', numTurns: 1,
    })
    bridge.send({ type: 'send', sessionId, text: 'APIERR:500' })
    expect(await bridge.waitFor((frame) => isResult(frame) && frame.isError === true, 'the API error result'))
      .toMatchObject({ subtype: 'success', isError: true, terminalReason: 'api_error' })
  })
})

describe('rejected sends', () => {
  it('a bad image is rejected and the sidecar keeps serving the session', async () => {
    const { bridge, sessionId } = await session()
    const rejected = randomUUID()
    bridge.send({ type: 'send', sessionId, uuid: rejected, text: 'look', images: [{ mediaType: 'image/svg+xml', data: 'PHN2Zy8+' }] })
    const rejection = await bridge.waitFor('sdk.send.rejected')
    expect(rejection).toMatchObject({ sessionId, uuid: rejected, code: 'INVALID_IMAGE' })
    expect(rejection.message).toMatch(/image\/svg\+xml/)
    expect(bridge.stderr()).toContain('"event":"send.rejected"')

    const next = randomUUID()
    bridge.send({ type: 'send', sessionId, uuid: next, text: 'hello' })
    expect(await bridge.waitFor(isResult, 'the next result')).toMatchObject({ sessionId, subtype: 'success' })
    // The rejected send never reached the CLI.
    expect(bridge.ledger().filter((row) => row.kind === 'prompt').map((row) => row.uuid)).toEqual([next])
    expect(commandStates(bridge, rejected)).toEqual([])
    expect(bridge.child.exitCode).toBeNull()
  })

  it('a send without a valid uuid is rejected', async () => {
    const { bridge, sessionId } = await session()
    bridge.send({ type: 'send', sessionId, uuid: null, text: 'hello' })
    expect(await bridge.waitFor('sdk.send.rejected')).toMatchObject({ sessionId, uuid: null, code: 'INVALID_SEND' })
    bridge.send({ type: 'send', sessionId, uuid: 'not-a-uuid', text: 'hello' })
    await bridge.waitFor(() => bridge.frames.filter((frame) => frame.type === 'sdk.send.rejected').length === 2, 'the second rejection')
    expect(bridge.ledger().filter((row) => row.kind === 'prompt')).toEqual([])
  })
})
