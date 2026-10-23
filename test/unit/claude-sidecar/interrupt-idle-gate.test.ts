// @vitest-environment node

// The sidecar mints no attention edge (core-runtime design §5.1, §5.5; C18):
// the server owns turn accounting and every `freshAgent.turn.complete` /
// `freshAgent.turn.waiting`, from the facts this sidecar forwards. Driven
// through the production index.mjs process over the CLI simulator
// (harness.ts): whatever a turn does - finish, fail, stop, wait on an
// approval or a question, end with the CLI's death - the sidecar writes no
// `sdk.turn.complete`, no `sdk.turn.waiting`, no `sdk.exit` and no failure
// banner (`sdk.error{turnFailure}`). What it does write is the facts: the
// enriched result, and the interrupt's receipt echoing the Stop's id.
//
// The interrupt gate this file used to pin (arm only while a result is owed,
// silence only the stopped turn's aborted result, a stale mark never
// swallows a bell) is the server's Stop latch now:
// crates/freshell-freshagent/src/claude_turns_stop_tests.rs and
// crates/freshell-ws/tests/freshagent_claude_turns.rs.

import { describe, expect, it } from 'vitest'
import { startRealSidecar, type RealSidecar, type SidecarFrame } from './harness'

/** Frames only the server may originate now. */
const EDGE_TYPES = new Set(['sdk.turn.complete', 'sdk.turn.waiting', 'sdk.exit'])

function edgesAndBanners(bridge: RealSidecar): SidecarFrame[] {
  return bridge.frames.filter((frame) => EDGE_TYPES.has(frame.type) || (frame.type === 'sdk.error' && frame.turnFailure !== undefined))
}

/** A booted session with nothing in flight (the CLI reports no init until a prompt, T1). */
async function createSession(bridge: RealSidecar) {
  const sessionId = await bridge.create({ requestId: 'create', model: 'opus' })
  await bridge.waitForBoot()
  return sessionId
}

const isToolUse = (frame: SidecarFrame) => frame.type === 'sdk.assistant' && frame.content?.some((block: { type: string }) => block.type === 'tool_use')

describe('the Claude sidecar mints no attention edge', () => {
  it('a finished turn, a failed one and an API error each end with their result and nothing else', async () => {
    const bridge = await startRealSidecar({
      program: { rules: [{ on: 'msg:prompt', match: { text: 'max turns' }, emit: [{ kind: 'completion', data: { subtype: 'error_max_turns' } }] }] },
      timeScale: 0.1,
    })
    const sessionId = await createSession(bridge)
    for (const [n, text] of ['hello', 'max turns', 'APIERR:500'].entries()) {
      bridge.send({ type: 'send', sessionId, text })
      await bridge.waitFor(() => bridge.frames.filter((frame) => frame.type === 'sdk.result').length === n + 1, `result ${n + 1}`)
    }
    await bridge.waitFor((frame) => frame.type === 'sdk.session.state' && frame.state === 'idle', 'the CLI goes idle')
    const results = bridge.frames.filter((frame) => frame.type === 'sdk.result')
    expect(results.map((result) => [result.subtype, result.isError, result.terminalReason])).toEqual([
      ['success', false, 'completed'],
      ['error_max_turns', true, undefined],
      ['success', true, 'api_error'],
    ])
    expect(edgesAndBanners(bridge)).toEqual([])
  })

  it.each([
    { stage: 'streamed text', prompt: 'HANG', started: (frame: SidecarFrame) => frame.type === 'sdk.session.init' },
    { stage: 'a tool call', prompt: 'TOOL:sleep=30', started: isToolUse },
  ])('a Stop during $stage: the receipt echoes its stopId, the aborted result carries its facts, and no edge or banner follows', async ({ prompt, started }) => {
    const bridge = await startRealSidecar()
    const sessionId = await createSession(bridge)

    bridge.send({ type: 'send', sessionId, text: prompt })
    await bridge.waitFor(started, `${prompt} under way`)
    bridge.send({ type: 'interrupt', sessionId, stopId: 'stop-1' })
    expect(await bridge.waitFor('sdk.interrupt_settled')).toMatchObject({ sessionId, stopId: 'stop-1', ok: true, stillQueued: [] })
    const result = await bridge.waitFor('sdk.result')
    expect(result).toMatchObject({ sessionId, subtype: 'error_during_execution', isError: true })
    expect(result.terminalReason).toMatch(/^aborted_/)
    expect(result.errorText, 'diagnostics never reach the server').toBeUndefined()

    bridge.send({ type: 'send', sessionId, text: 'after the stop' })
    await bridge.waitFor((frame) => frame.type === 'sdk.result' && frame.subtype === 'success', 'the next turn result')
    expect(edgesAndBanners(bridge)).toEqual([])
  })

  it('an interrupt with nothing running settles ok:true with its stopId (the CLI resolves it) and nothing else', async () => {
    const bridge = await startRealSidecar()
    const sessionId = await createSession(bridge)
    bridge.send({ type: 'interrupt', sessionId, stopId: 'stop-idle' })
    expect(await bridge.waitFor('sdk.interrupt_settled')).toMatchObject({ sessionId, stopId: 'stop-idle', ok: true })
    bridge.send({ type: 'send', sessionId, text: 'next turn' })
    expect(await bridge.waitFor('sdk.result')).toMatchObject({ sessionId, subtype: 'success' })
    expect(edgesAndBanners(bridge)).toEqual([])
  })

  it('an approval and a question are forwarded as requests with no waiting edge', async () => {
    const bridge = await startRealSidecar({
      program: {
        rules: [
          { on: 'msg:prompt', match: { text: 'ask approval' }, emit: [{ kind: 'approval', data: { tool: 'Bash', input: { command: 'ls' } } }] },
          { on: 'msg:prompt', match: { text: 'ask question' }, emit: [{ kind: 'question', data: { questions: [{ question: 'Pick', header: 'Q', options: [{ label: 'A', description: 'a' }], multiSelect: false }] } }] },
        ],
      },
    })
    const sessionId = await bridge.create({ requestId: 'create', model: 'opus', permissionMode: 'default' })
    await bridge.waitForBoot()
    bridge.send({ type: 'send', sessionId, text: 'ask approval' })
    const approval = await bridge.waitFor('sdk.permission.request')
    bridge.send({ type: 'permission.respond', sessionId, requestId: approval.requestId, decision: { behavior: 'allow', updatedInput: { command: 'ls' } } })
    await bridge.waitFor('sdk.result')
    bridge.send({ type: 'send', sessionId, text: 'ask question' })
    const question = await bridge.waitFor('sdk.question.request')
    bridge.send({ type: 'question.respond', sessionId, requestId: question.requestId, answers: { Pick: 'A' } })
    await bridge.waitFor(() => bridge.frames.filter((frame) => frame.type === 'sdk.result').length === 2, 'the second result')
    expect(edgesAndBanners(bridge)).toEqual([])
  })

  it('a turn the CLI dies under ends with the stream end alone', async () => {
    const bridge = await startRealSidecar({
      program: { rules: [{ on: 'msg:prompt', match: { text: 'CRASH_SOON' }, emit: [{ kind: 'crash', delayMs: 300 }] }] },
    })
    const sessionId = await createSession(bridge)
    bridge.send({ type: 'send', sessionId, text: 'CRASH_SOON' })
    expect(await bridge.waitFor('sdk.stream.ended')).toMatchObject({ sessionId, reason: 'cli_exited' })
    expect(bridge.frames.filter((frame) => frame.type === 'sdk.result')).toEqual([])
    expect(edgesAndBanners(bridge)).toEqual([])
  })

  it('a request for a session this sidecar does not host is refused: a send is rejected, an interrupt settles ok:false', async () => {
    const bridge = await startRealSidecar()
    await createSession(bridge)
    bridge.send({ type: 'send', sessionId: 'not-hosted', uuid: '88888888-8888-4888-8888-888888888888', text: 'hello' })
    expect(await bridge.waitFor('sdk.send.rejected')).toMatchObject({ sessionId: 'not-hosted', uuid: '88888888-8888-4888-8888-888888888888', code: 'SESSION_NOT_FOUND' })
    bridge.send({ type: 'interrupt', sessionId: 'not-hosted', stopId: 'stop-x' })
    expect(await bridge.waitFor('sdk.interrupt_settled')).toMatchObject({ sessionId: 'not-hosted', stopId: 'stop-x', ok: false })
    expect(bridge.frames.filter((frame) => frame.type === 'sdk.error')).toEqual([])
  })
})
