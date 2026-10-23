// @vitest-environment node

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { startRealSidecar, type RealSidecar } from './harness.js'

async function sendAndSettle(bridge: RealSidecar, sessionId: string, text: string) {
  const uuid = randomUUID()
  bridge.send({ type: 'send', sessionId, uuid, text })
  await bridge.waitFor(
    (frame) => frame.type === 'sdk.command' && frame.uuid === uuid && frame.state === 'completed',
    `the completed ${text} command`,
  )
  return uuid
}

describe('conversation reset identity', () => {
  it.each([false, true])('announces the actual post-clear session before its init (warm=%s)', async (warm) => {
    const bridge = await startRealSidecar()
    const durable = randomUUID()
    const sessionId = await bridge.create({ sessionId: durable })
    if (warm) await sendAndSettle(bridge, sessionId, 'before clear')

    const beforeClear = bridge.frames.length
    const clearUuid = await sendAndSettle(bridge, sessionId, '/clear')
    const cleared = bridge.frames.slice(beforeClear)
    const init = cleared.find((frame) => frame.type === 'sdk.session.init')!
    expect(init.cliSessionId).not.toBe(durable)
    const rekeys = cleared.filter((frame) => frame.type === 'sdk.session.rekeyed')
    // T16: conversation_reset.new_conversation_id is a reset nonce. The next
    // init supplies the actual durable session UUID, which must be followed.
    expect(rekeys).toEqual([{
      type: 'sdk.session.rekeyed', sessionId,
      newSessionId: init.cliSessionId, reason: 'conversation_reset',
    }])
    expect(cleared.indexOf(rekeys[0])).toBeLessThan(cleared.indexOf(init))
    expect(cleared.find((frame) => frame.type === 'sdk.command' && frame.uuid === clearUuid && frame.state === 'completed')).toBeTruthy()

    // The sidecar's control identity survives the durable rekey. Its next
    // prompt runs in the new conversation and creates no second rekey.
    await sendAndSettle(bridge, sessionId, 'after clear')
    const prompt = await bridge.waitForPrompt(warm ? 3 : 2)
    expect(prompt.durable).toBe(init.cliSessionId)
    expect(bridge.frames.filter((frame) => frame.type === 'sdk.session.rekeyed')).toHaveLength(1)
  })

  it('does not treat ordinary per-turn init frames as conversation resets', async () => {
    const bridge = await startRealSidecar()
    const durable = randomUUID()
    const sessionId = await bridge.create({ sessionId: durable })
    await sendAndSettle(bridge, sessionId, 'first')
    await sendAndSettle(bridge, sessionId, 'second')
    expect(bridge.frames.filter((frame) => frame.type === 'sdk.session.init').map((frame) => frame.cliSessionId)).toEqual([durable, durable])
    expect(bridge.frames.filter((frame) => frame.type === 'sdk.session.rekeyed')).toEqual([])
  })
})
