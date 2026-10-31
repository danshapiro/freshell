// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { createClaudeCapture as capture } from '../../helpers/claude-session-capture.js'

afterEach(() => { vi.useRealTimers() })

const running = { type: 'system', subtype: 'session_state_changed', state: 'running' }
const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' }
const completed = { type: 'command_lifecycle', command_uuid: 'u1', state: 'completed' }
const success = { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', user_message_uuid: 'u1', session_id: 'session-X' }

it.each([false, true])('keeps a successful result capture open through completed and a later idle (prior idle: %s)', async (priorIdle) => {
  const { session, query, events, deliver } = capture()
  if (priorIdle) await deliver(idle)
  await deliver(running, success)
  const closing = session.close()
  try {
    await Promise.resolve()
    expect(query.close).not.toHaveBeenCalled()
    expect(events.some(event => event.k === 'close')).toBe(false)
    await deliver(completed)
    expect(query.close).not.toHaveBeenCalled()
    await deliver({ ...idle })
    await closing
    const closeAt = events.findIndex(event => event.k === 'close')
    expect(events.slice(0, closeAt).filter(event => event.k === 'msg').slice(-3).map(event => event.m))
      .toEqual([success, completed, idle])
    expect(query.close).toHaveBeenCalledOnce()
  } finally {
    query.close()
    await closing
  }
})

it.each([
  { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' },
  { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' },
  { ...success, is_error: true, terminal_reason: 'api_error' },
  { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0 },
])('preserves deliberate close after $subtype/$terminal_reason without requiring successful idle', async (result) => {
  const { session, query, events, deliver } = capture()
  await deliver(result)
  await session.close()
  expect(query.close).toHaveBeenCalledOnce()
  expect(events.filter(event => event.k === 'msg').map(event => event.m)).toEqual([result])
  expect(events.some(event => event.k === 'wait-missed')).toBe(false)
})

it('closes an unfinished new turn without waiting on a previous successful result', async () => {
  const { session, query, events, deliver } = capture()
  // Queued turns start after the previous result with no idle between them.
  await deliver(running, success, completed,
    { type: 'command_lifecycle', command_uuid: 'u2', state: 'started' })
  await session.close()
  expect(query.close).toHaveBeenCalledOnce()
  expect(events.some(event => event.k === 'wait-missed')).toBe(false)
})

it('fails a missing successful idle within a finite deadline and still closes the owned query', async () => {
  vi.useFakeTimers()
  const { session, query, events, deliver } = capture()
  await deliver(running, success, completed)
  const closing = session.close()
  const rejected = expect(closing).rejects.toThrow(/successful result.*idle/)
  rejected.catch(() => {})
  await vi.advanceTimersByTimeAsync(10_000)
  await rejected
  expect(query.close).toHaveBeenCalledOnce()
  expect(events.some(event => event.k === 'wait-missed')).toBe(true)
})
