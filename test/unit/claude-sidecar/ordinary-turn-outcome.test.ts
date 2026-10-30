// @vitest-environment node
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRealSidecar } from './harness.js'

const directory = path.dirname(fileURLToPath(import.meta.url))
const sdkFixture = path.join(directory, 'fixtures', 'ordinary-turn-outcome-query-module.mjs')

describe('Claude ordinary-turn facts for the Rust verdict', () => {
  it.each([
    ['__test_success__', 'success', false],
    ['__test_failed_result__', 'error_during_execution', true],
  ])('forwards the actual result of %s without originating a second completion', async (marker, subtype, isError) => {
    const bridge = await startRealSidecar({ env: { FRESHELL_CLAUDE_SDK_QUERY_MODULE: sdkFixture } })
    const sessionId = await bridge.create()
    bridge.send({ type: 'send', sessionId, text: marker })
    expect(await bridge.waitFor('sdk.result')).toMatchObject({ sessionId, subtype, isError })
    await bridge.barrier(sessionId)
    if (isError) expect(bridge.frames.find(frame => frame.type === 'sdk.result')?.errorText)
      .toBe('synthetic provider failure detail')
    expect(bridge.frames.some(frame => frame.type === 'sdk.turn.complete' || frame.type === 'sdk.turn.waiting')).toBe(false)
  })

  it('reports result-less EOF once, then exits so Rust can settle the pending turn', async () => {
    const bridge = await startRealSidecar({ env: { FRESHELL_CLAUDE_SDK_QUERY_MODULE: sdkFixture } })
    const sessionId = await bridge.create()
    bridge.send({ type: 'send', sessionId, text: '__test_pending_eof__' })
    expect(await bridge.waitExit()).toEqual({ code: 3, signal: null })
    expect(bridge.frames.at(-1)).toMatchObject({ type: 'sdk.stream.ended', sessionId, reason: 'stream_eof' })
    expect(bridge.frames.filter(frame => frame.type === 'sdk.stream.ended')).toHaveLength(1)
    expect(bridge.frames.some(frame => frame.type === 'sdk.result' || frame.type === 'sdk.turn.complete' || frame.type === 'sdk.turn.waiting')).toBe(false)
  })
})
