// @vitest-environment node

// The pure mapping from the CLI's lifecycle messages to the sidecar's fact
// frames (crates/freshell-claude-sidecar/lifecycle-frames.mjs; core-runtime
// design §5.1, C16). The message shapes are the pinned CLI's: T8 (per-command
// lifecycle and replays), T9 (session state), T13 (interrupt receipts), T15
// (status null with a compaction's outcome), T17 (tool heartbeats). The
// sidecar forwards facts only for the commands it sent: the CLI also replays
// and queues uuids it minted itself, which the server never knew.

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createHeartbeatLimiter,
  createLifecycleState,
  HEARTBEAT_INTERVAL_MS,
  lifecycleFrames,
  rememberSend,
  stillQueuedOf,
} from '../../../crates/freshell-claude-sidecar/lifecycle-frames.mjs'
import { startRealSidecar } from './harness'

const SENT = '3f0b9d2e-1111-4222-8333-444455556666'
const OTHER = '9a8b7c6d-5555-4666-8777-888899990000'

function stateWithSent(...uuids: string[]) {
  const state = createLifecycleState()
  for (const uuid of uuids) rememberSend(state, uuid)
  return state
}

describe('command lifecycle facts', () => {
  it('forwards every lifecycle state of a command the sidecar sent', () => {
    for (const lifecycle of ['queued', 'started', 'completed', 'cancelled', 'discarded']) {
      const state = stateWithSent(SENT)
      expect(lifecycleFrames('s1', { type: 'command_lifecycle', command_uuid: SENT, state: lifecycle }, state, 0))
        .toEqual([{ type: 'sdk.command', sessionId: 's1', uuid: SENT, state: lifecycle }])
    }
  })

  it('forwards nothing for a command the CLI queued itself, or a state it does not know', () => {
    const state = stateWithSent(SENT)
    expect(lifecycleFrames('s1', { type: 'command_lifecycle', command_uuid: OTHER, state: 'started' }, state, 0)).toEqual([])
    expect(lifecycleFrames('s1', { type: 'command_lifecycle', command_uuid: SENT, state: 'paused' }, state, 0)).toEqual([])
  })

  it('reports the first replay of a sent command, once', () => {
    const state = stateWithSent(SENT)
    const replay = { type: 'user', isReplay: true, uuid: SENT, message: { role: 'user', content: 'hello' }, parent_tool_use_id: null }
    expect(lifecycleFrames('s1', replay, state, 0)).toEqual([{ type: 'sdk.command', sessionId: 's1', uuid: SENT, state: 'replayed' }])
    expect(lifecycleFrames('s1', replay, state, 0)).toEqual([])
  })

  it('ignores replays the CLI minted itself and user rows that are not replays', () => {
    const state = stateWithSent(SENT)
    // setModel's /model output is replayed under a uuid the CLI minted (T8).
    expect(lifecycleFrames('s1', { type: 'user', isReplay: true, uuid: OTHER, message: { role: 'user', content: '<local-command-stdout>' } }, state, 0)).toEqual([])
    // A tool result is an ordinary user row.
    expect(lifecycleFrames('s1', { type: 'user', uuid: SENT, message: { role: 'user', content: [] } }, state, 0)).toEqual([])
  })

  it('keeps every outstanding command through terminal lifecycle and interrupt receipts', () => {
    const state = createLifecycleState()
    const uuid = (i: number) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
    const uuids = Array.from({ length: 300 }, (_, i) => uuid(i))

    const queued = uuids.flatMap((commandId) => {
      rememberSend(state, commandId)
      return lifecycleFrames('s1', { type: 'command_lifecycle', command_uuid: commandId, state: 'queued' }, state, 0)
    })
    expect(queued).toEqual(uuids.map((commandId) => ({
      type: 'sdk.command', sessionId: 's1', uuid: commandId, state: 'queued',
    })))
    expect(stillQueuedOf({ still_queued: uuids }, state)).toEqual(uuids)

    const retired = [
      ['completed', uuids[0]],
      ['cancelled', uuids[1]],
      ['discarded', uuids[2]],
    ] as const
    for (const [terminalState, commandId] of retired) {
      expect(lifecycleFrames('s1', { type: 'command_lifecycle', command_uuid: commandId, state: terminalState }, state, 0))
        .toEqual([{ type: 'sdk.command', sessionId: 's1', uuid: commandId, state: terminalState }])
    }

    expect(stillQueuedOf({ still_queued: uuids }, state)).toEqual(uuids.slice(retired.length))
    expect(lifecycleFrames('s1', { type: 'command_lifecycle', command_uuid: uuids[0], state: 'started' }, state, 0)).toEqual([])
    expect(lifecycleFrames('s1', { type: 'command_lifecycle', command_uuid: uuids.at(-1), state: 'started' }, state, 0))
      .toEqual([{ type: 'sdk.command', sessionId: 's1', uuid: uuids.at(-1), state: 'started' }])
  })
})

describe('real sidecar lifecycle queue', () => {
  it('forwards and drains more than 256 queued commands through an interrupt receipt', async () => {
    const bridge = await startRealSidecar({ timeScale: 0 })
    const sessionId = await bridge.create({ requestId: 'create-lifecycle-capacity' })
    await bridge.waitForBoot()

    const runningId = randomUUID()
    const queuedIds = Array.from({ length: 300 }, () => randomUUID())
    const queuedIdSet = new Set(queuedIds)
    const queuedSeen = new Set<string>()
    bridge.send({ type: 'send', sessionId, uuid: runningId, text: 'HANG' })
    await bridge.waitFor(
      (frame) => frame.type === 'sdk.command' && frame.uuid === runningId && frame.state === 'started',
      'the first command to start',
    )

    bridge.sendLines(queuedIds.map((uuid) => ({ type: 'send', sessionId, uuid, text: 'queued command' })))
    await bridge.waitFor(
      (frame) => {
        if (frame.type === 'sdk.command' && frame.state === 'queued' && queuedIdSet.has(frame.uuid)) queuedSeen.add(frame.uuid)
        return queuedSeen.size === queuedIdSet.size
      },
      'all queued command lifecycle frames',
      60_000,
    )

    bridge.send({ type: 'interrupt', sessionId, stopId: 'capacity-stop' })
    const receipt = await bridge.waitFor(
      (frame) => frame.type === 'sdk.interrupt_settled' && frame.stopId === 'capacity-stop',
      'the interrupt receipt',
      60_000,
    )
    expect(receipt).toMatchObject({ ok: true, stillQueued: queuedIds })

    const terminalStates = new Set(['completed', 'cancelled', 'discarded'])
    const terminalSeen = new Set<string>()
    await bridge.waitFor(
      (frame) => {
        if (frame.type === 'sdk.command' && queuedIdSet.has(frame.uuid) && terminalStates.has(frame.state)) terminalSeen.add(frame.uuid)
        return terminalSeen.size === queuedIdSet.size
      },
      'all queued commands to reach terminal lifecycle',
      60_000,
    )
    const lastTerminalIndex = bridge.frames.reduce((last, frame, index) =>
      frame.type === 'sdk.command' && queuedIdSet.has(frame.uuid) && terminalStates.has(frame.state) ? index : last,
    -1)
    await bridge.waitFor(
      (frame) => frame.type === 'sdk.session.state' && frame.state === 'idle'
        && bridge.frames.indexOf(frame) > lastTerminalIndex,
      'the session to return to idle after draining the queue',
      60_000,
    )

    const forwardedTerminalIds = new Set(
      bridge.frames
        .filter((frame) => frame.type === 'sdk.command' && queuedIdSet.has(frame.uuid) && terminalStates.has(frame.state))
        .map((frame) => frame.uuid),
    )
    expect(forwardedTerminalIds).toEqual(new Set(queuedIds))
  }, 90_000)
})

describe('session state and status facts', () => {
  it('forwards each session state the CLI reports (T9)', () => {
    const state = createLifecycleState()
    for (const sessionState of ['running', 'requires_action', 'idle']) {
      expect(lifecycleFrames('s1', { type: 'system', subtype: 'session_state_changed', state: sessionState }, state, 0))
        .toEqual([{ type: 'sdk.session.state', sessionId: 's1', state: sessionState }])
    }
    expect(lifecycleFrames('s1', { type: 'system', subtype: 'session_state_changed', state: 'sleeping' }, state, 0)).toEqual([])
  })

  it('forwards the end of a status with what it carries: a compaction outcome or a permission mode (T15)', () => {
    const state = createLifecycleState()
    expect(lifecycleFrames('s1', { type: 'system', subtype: 'status', status: null, compact_result: 'success' }, state, 0))
      .toEqual([{ type: 'sdk.status', sessionId: 's1', status: null, compactResult: 'success' }])
    expect(lifecycleFrames('s1', { type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'Not enough messages to compact.' }, state, 0))
      .toEqual([{ type: 'sdk.status', sessionId: 's1', status: null, compactResult: 'failed', compactError: 'Not enough messages to compact.' }])
    expect(lifecycleFrames('s1', { type: 'system', subtype: 'status', status: null, permissionMode: 'plan' }, state, 0))
      .toEqual([{ type: 'sdk.status', sessionId: 's1', status: null, permissionMode: 'plan' }])
  })

  it('forwards a model request as turn evidence, and leaves compacting to the content mapping', () => {
    const state = createLifecycleState()
    expect(lifecycleFrames('s1', { type: 'system', subtype: 'status', status: 'requesting' }, state, 0))
      .toEqual([{ type: 'sdk.status', sessionId: 's1', status: 'requesting' }])
    expect(lifecycleFrames('s1', { type: 'system', subtype: 'status', status: 'compacting' }, state, 0)).toEqual([])
  })
})

describe('heartbeats', () => {
  it('turns a tool heartbeat into a liveness fact for the tool it belongs to (T17)', () => {
    const state = createLifecycleState()
    // The CLI stamps the heartbeat with its own id and names the tool as its parent.
    const beat = { type: 'tool_progress', tool_use_id: 'toolu_1-heartbeat-0', tool_name: 'Bash', parent_tool_use_id: 'toolu_1', elapsed_time_seconds: 30, heartbeat: true }
    expect(lifecycleFrames('s1', beat, state, 1_000))
      .toEqual([{ type: 'sdk.heartbeat', sessionId: 's1', kind: 'tool', toolUseId: 'toolu_1', elapsedMs: 30_000 }])
  })

  it('treats task and API-retry progress as heartbeats of their own kinds', () => {
    const state = createLifecycleState()
    expect(lifecycleFrames('s1', { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_2', description: 'sleep' }, state, 0))
      .toEqual([{ type: 'sdk.heartbeat', sessionId: 's1', kind: 'task', toolUseId: 'toolu_2' }])
    expect(lifecycleFrames('s1', { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529 }, state, 0))
      .toEqual([{ type: 'sdk.heartbeat', sessionId: 's1', kind: 'retry' }])
  })

  it('sends at most one heartbeat per kind every five seconds', () => {
    const state = createLifecycleState()
    const tool = (elapsed: number) => ({ type: 'tool_progress', tool_use_id: `toolu_1-heartbeat-${elapsed}`, tool_name: 'Bash', parent_tool_use_id: 'toolu_1', elapsed_time_seconds: elapsed, heartbeat: true })
    const task = { type: 'system', subtype: 'task_progress', task_id: 't1', description: 'd', usage: { total_tokens: 1, tool_uses: 0, duration_ms: 1 } }
    expect(lifecycleFrames('s1', tool(30), state, 10_000)).toHaveLength(1)
    expect(lifecycleFrames('s1', tool(60), state, 10_000 + HEARTBEAT_INTERVAL_MS - 1)).toEqual([])
    // Another kind has its own allowance.
    expect(lifecycleFrames('s1', task, state, 10_001)).toHaveLength(1)
    expect(lifecycleFrames('s1', tool(90), state, 10_000 + HEARTBEAT_INTERVAL_MS)).toHaveLength(1)
  })

  it('the limiter admits the first beat of a kind and the next one a full interval later', () => {
    const limiter = createHeartbeatLimiter(100)
    expect(limiter.admit('tool', 5)).toBe(true)
    expect(limiter.admit('tool', 104)).toBe(false)
    expect(limiter.admit('retry', 104)).toBe(true)
    expect(limiter.admit('tool', 105)).toBe(true)
  })
})

describe('interrupt receipts', () => {
  it('lists only the sent commands the receipt says will still run (T12, T13)', () => {
    const state = stateWithSent(SENT)
    // The CLI may list uuids it enqueued itself; the server never knew them.
    expect(stillQueuedOf({ still_queued: [OTHER, SENT] }, state)).toEqual([SENT])
    expect(stillQueuedOf({ still_queued: [] }, state)).toEqual([])
  })

  it('has no list when the CLI sent no receipt (older CLIs resolve undefined)', () => {
    const state = stateWithSent(SENT)
    expect(stillQueuedOf(undefined, state)).toBeUndefined()
    expect(stillQueuedOf({}, state)).toBeUndefined()
  })
})

describe('other messages', () => {
  it('produce no lifecycle facts', () => {
    const state = stateWithSent(SENT)
    for (const msg of [
      { type: 'assistant', uuid: SENT, message: { content: [] } },
      { type: 'result', subtype: 'success' },
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'system', subtype: 'init', session_id: 'x' },
      { type: 'system', subtype: 'compact_boundary' },
    ]) {
      expect(lifecycleFrames('s1', msg, state, 0)).toEqual([])
    }
  })
})
