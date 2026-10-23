// @vitest-environment node

// The content half of the pure SDK message -> sidecar frame mapping
// (crates/freshell-claude-sidecar/sdk-message-frames.mjs): what reaches the
// server for the messages the transcript owns (assistant, user, stream_event,
// compaction and status frames). The `result` half has its own tests
// (sdk-message-frames.test.ts).
//
// The sequences fed here were recorded from the pinned CLI 2.1.237 against a
// local fake endpoint (test/integration/providers/claude-capture-fixtures.mjs),
// so every shape is one the real CLI produces.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createFrameState,
  frameLogRecord,
  framesForSdkMessage,
} from '../../../crates/freshell-claude-sidecar/sdk-message-frames.mjs'

const RECORDINGS = path.resolve(__dirname, '../../fixtures/fresh-agent/claude/real-cli-2.1.237')
const SCENARIOS = ['tools-sync', 'agent-async', 'agent-failed', 'compact-ok', 'compact-fail', 'api-error', 'image'] as const

type Msg = Record<string, any>

/** The SDK messages the pinned CLI produced for one recorded scenario, in order. */
function recorded(scenario: string): Msg[] {
  return fs.readFileSync(path.join(RECORDINGS, scenario, 'sdk.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).msg as Msg)
}

/** The uuids of the lines the CLI wrote: the main transcript and every subagent transcript. */
function persistedUuids(scenario: string): Set<string> {
  const files = [path.join(RECORDINGS, scenario, 'session.jsonl')]
  const subagents = path.join(RECORDINGS, scenario, 'session', 'subagents')
  if (fs.existsSync(subagents)) {
    for (const name of fs.readdirSync(subagents)) if (name.endsWith('.jsonl')) files.push(path.join(subagents, name))
  }
  const uuids = new Set<string>()
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line)
      if (typeof row.uuid === 'string') uuids.add(row.uuid)
    }
  }
  return uuids
}

/** What the sidecar knows about its session when a message arrives. */
function session(state = createFrameState(), overrides: Record<string, unknown> = {}) {
  return { stream: state, permissionMode: 'bypassPermissions', turnPending: true, ...overrides }
}

/** Every message of a recording with the frames it maps to (one mapping state per session). */
function mapRecording(scenario: string) {
  const state = createFrameState()
  return recorded(scenario).map((msg) => ({ msg, frames: framesForSdkMessage('s1', msg, session(state)) }))
}

const isStatus = (status: unknown) => (msg: Msg) => msg.type === 'system' && msg.subtype === 'status' && msg.status === status

describe('framesForSdkMessage over the pinned CLI\'s recorded sequences', () => {
  it.each(SCENARIOS)('%s: each assistant message becomes one sdk.assistant with its content blocks and model', (scenario) => {
    const mapped = mapRecording(scenario).filter(({ msg }) => msg.type === 'assistant')
    expect(mapped.length).toBeGreaterThan(0)
    for (const { msg, frames } of mapped) {
      const assistant = frames.filter((frame: Msg) => frame.type === 'sdk.assistant')
      expect(assistant).toHaveLength(1)
      expect(assistant[0]).toMatchObject({ sessionId: 's1', model: msg.message.model })
      expect(assistant[0].content.map((block: Msg) => block.type)).toEqual(msg.message.content.map((block: Msg) => block.type))
    }
  })

  it.each(SCENARIOS)('%s: sdk.assistant carries the message uuid, the API message id and the parent tool use id', (scenario) => {
    for (const { msg, frames } of mapRecording(scenario).filter(({ msg }) => msg.type === 'assistant')) {
      expect(frames.find((frame: Msg) => frame.type === 'sdk.assistant')).toMatchObject({
        uuid: msg.uuid,
        messageId: msg.message.id,
        parentToolUseId: msg.parent_tool_use_id ?? null,
      })
    }
  })

  it.each(SCENARIOS)('%s: every message the CLI wrote to its transcript is announced once, after its content, and nothing else is', (scenario) => {
    const persisted = persistedUuids(scenario)
    const mapped = mapRecording(scenario)
    const announced: string[] = []
    for (const { msg, frames } of mapped) {
      const announcements = frames.filter((frame: Msg) => frame.type === 'sdk.session.changed' && frame.reason === 'transcript')
      for (const announcement of announcements) {
        expect(announcement).toEqual({ type: 'sdk.session.changed', sessionId: 's1', reason: 'transcript', uuid: msg.uuid, parentToolUseId: msg.parent_tool_use_id ?? null })
        expect(frames.at(-1)).toBe(announcement)
        announced.push(announcement.uuid)
      }
    }
    // Exactly the SDK messages whose uuid is a line of the main or a subagent transcript.
    const expected = mapped.map(({ msg }) => msg.uuid).filter((uuid) => persisted.has(uuid))
    expect(expected.length).toBeGreaterThan(0)
    expect(announced).toEqual(expected)
  })

  it('announces sidechain (subagent) messages with the tool use that started the subagent', () => {
    const sidechain = mapRecording('tools-sync').filter(({ msg }) => (msg.type === 'assistant' || msg.type === 'user') && msg.parent_tool_use_id)
    expect(sidechain.length).toBeGreaterThan(0)
    for (const { frames } of sidechain) {
      expect(frames.at(-1)).toMatchObject({ type: 'sdk.session.changed', reason: 'transcript', parentToolUseId: 'toolu_agent1' })
    }
  })

  it('announces the transcript lines of a compaction and of local command output', () => {
    const boundary = mapRecording('compact-ok').find(({ msg }) => msg.type === 'system' && msg.subtype === 'compact_boundary')!
    expect(boundary.frames.map((frame: Msg) => frame.type)).toEqual(['sdk.compact_boundary', 'sdk.session.changed'])
    expect(boundary.frames[1]).toMatchObject({ reason: 'transcript', uuid: boundary.msg.uuid, parentToolUseId: null })
    // The SDK's own local command output message (SDKLocalCommandOutputMessage).
    const output = { type: 'system', subtype: 'local_command_output', content: 'Total cost: $0.00', uuid: '5f0f3a3e-0d0e-4a43-9a0e-0a3c6b1c2d3e', session_id: 'c1' }
    expect(framesForSdkMessage('s1', output, session())).toEqual([
      { type: 'sdk.session.changed', sessionId: 's1', reason: 'transcript', uuid: output.uuid, parentToolUseId: null },
    ])
  })

  it('a message without a uuid is not announced', () => {
    expect(framesForSdkMessage('s1', { type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null }, session())).toEqual([])
    const frames = framesForSdkMessage('s1', { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'x' }] }, parent_tool_use_id: null }, session())
    expect(frames.map((frame: Msg) => frame.type)).toEqual(['sdk.assistant'])
  })

  it.each(SCENARIOS)('%s: messages that carry nothing for the server map to no frame', (scenario) => {
    const silent = (msg: Msg) => msg.type === 'result'
      || (msg.type === 'system' && ['init', 'task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed', 'thinking_tokens'].includes(msg.subtype))
      || isStatus('requesting')(msg)
    for (const { msg, frames } of mapRecording(scenario).filter(({ msg }) => silent(msg))) {
      expect(frames, JSON.stringify(msg).slice(0, 200)).toEqual([])
    }
  })

  it.each(SCENARIOS)('%s: only the main thread\'s message and block starts, text and thinking deltas and block stops are streamed', (scenario) => {
    for (const { msg, frames } of mapRecording(scenario).filter(({ msg }) => msg.type === 'stream_event')) {
      const event = msg.event
      const streamed = msg.parent_tool_use_id == null && (
        ['message_start', 'content_block_start', 'content_block_stop'].includes(event.type)
        || (event.type === 'content_block_delta' && ['text_delta', 'thinking_delta'].includes(event.delta?.type))
      )
      if (streamed) expect(frames).toEqual([{ type: 'sdk.stream', sessionId: 's1', event, parentToolUseId: null, messageId: expect.any(String) }])
      else expect(frames, JSON.stringify(event)).toEqual([])
    }
  })

  it('drops the events nothing renders: tool input JSON, signatures, message deltas and stops', () => {
    const dropped = mapRecording('tools-sync')
      .filter(({ msg }) => msg.type === 'stream_event')
      .filter(({ frames }) => frames.length === 0)
      .map(({ msg }) => msg.event.delta?.type ?? msg.event.type)
    expect(new Set(dropped)).toEqual(new Set(['input_json_delta', 'signature_delta', 'message_delta', 'message_stop']))
  })

  it.each(SCENARIOS)('%s: each streamed block carries the API message id of the sdk.assistant it becomes, and its deltas add up to that block', (scenario) => {
    const frames = mapRecording(scenario).flatMap((entry) => entry.frames)
    let open: { messageId: string; index: number; kind: string; text: string } | undefined
    const finished: Array<{ messageId: string; kind: string; text: string }> = []
    for (const frame of frames.filter((f: Msg) => f.type === 'sdk.stream')) {
      const event = frame.event
      if (event.type === 'content_block_start') open = { messageId: frame.messageId, index: event.index, kind: event.content_block.type, text: '' }
      if (event.type === 'content_block_delta') {
        expect(open).toMatchObject({ messageId: frame.messageId, index: event.index })
        open!.text += event.delta.text ?? event.delta.thinking
      }
      if (event.type === 'content_block_stop') {
        expect(open).toMatchObject({ messageId: frame.messageId, index: event.index })
        finished.push({ messageId: open!.messageId, kind: open!.kind, text: open!.text })
        open = undefined
      }
    }
    // The main thread's assistant messages, block by block, in the same order.
    const blocks = frames
      .filter((f: Msg) => f.type === 'sdk.assistant' && f.parentToolUseId === null && f.model !== '<synthetic>')
      .map((f: Msg) => ({ messageId: f.messageId, kind: f.content[0].type, text: f.content[0].text ?? f.content[0].thinking ?? '' }))
    expect(finished).toEqual(blocks)
  })

  it('a subagent\'s stream does not touch the main thread\'s message id', () => {
    const state = createFrameState()
    const start = (id: string, parent: string | null) => ({ type: 'stream_event', event: { type: 'message_start', message: { id, content: [] } }, parent_tool_use_id: parent, uuid: `u-${id}` })
    const delta = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }, parent_tool_use_id: null, uuid: 'u-d' }
    expect(framesForSdkMessage('s1', start('msg_main', null), session(state))).toHaveLength(1)
    expect(framesForSdkMessage('s1', start('msg_sub', 'toolu_agent1'), session(state))).toEqual([])
    expect(framesForSdkMessage('s1', delta, session(state))).toEqual([
      { type: 'sdk.stream', sessionId: 's1', event: delta.event, parentToolUseId: null, messageId: 'msg_main' },
    ])
    // Each session keeps its own stream state.
    const other = createFrameState()
    framesForSdkMessage('s2', start('msg_other', null), session(other))
    expect(framesForSdkMessage('s1', delta, session(state))[0].messageId).toBe('msg_main')
  })

  it('projects each content block the way the server reads it (a thinking block loses its signature)', () => {
    const blocks = mapRecording('tools-sync')
      .filter(({ msg }) => msg.type === 'assistant' && msg.parent_tool_use_id === null)
      .slice(0, 3)
      .map(({ frames }) => frames.find((frame: Msg) => frame.type === 'sdk.assistant').content)
    expect(blocks).toEqual([
      [{ type: 'thinking', thinking: 'plan the write' }],
      [{ type: 'text', text: 'Writing the file now.' }],
      [{ type: 'tool_use', id: 'toolu_write1', name: 'Write', input: { file_path: '/fixture/ws/a.txt', content: 'one\n' } }],
    ])
  })

  it('a compaction: the compacting status and the boundary (with its trigger) reach the server', () => {
    const mapped = mapRecording('compact-ok')
    const compacting = mapped.find(({ msg }) => isStatus('compacting')(msg))!
    expect(compacting.frames).toEqual([{ type: 'sdk.status', sessionId: 's1', status: 'compacting' }])
    const boundary = mapped.find(({ msg }) => msg.type === 'system' && msg.subtype === 'compact_boundary')!
    expect(boundary.frames.filter((frame: Msg) => frame.type === 'sdk.compact_boundary'))
      .toEqual([{ type: 'sdk.compact_boundary', sessionId: 's1', trigger: 'manual' }])
  })

  it('a compaction boundary with a missing or unknown trigger counts as automatic', () => {
    for (const compact_metadata of [undefined, {}, { trigger: 'other' }, { trigger: 'auto' }]) {
      const frames = framesForSdkMessage('s1', { type: 'system', subtype: 'compact_boundary', compact_metadata, uuid: 'b1' }, session())
      expect(frames.find((frame: Msg) => frame.type === 'sdk.compact_boundary')).toEqual({ type: 'sdk.compact_boundary', sessionId: 's1', trigger: 'auto' })
    }
  })

  it('ignores kinds it does not map, and a message with no type', () => {
    expect(framesForSdkMessage('s1', { type: 'tool_progress', tool_use_id: 't1', heartbeat: true }, session())).toEqual([])
    expect(framesForSdkMessage('s1', { type: 'system', subtype: 'session_state_changed', state: 'idle' }, session())).toEqual([])
    expect(framesForSdkMessage('s1', {}, session())).toEqual([])
  })
})

// Shapes the pinned CLI emits that the recordings above do not contain
// (docs/plans/2026-10-22-freshclaude-transcript-live.md §3: F11 api_retry,
// recorded from a 529 response) or that only a claude.ai subscription or a
// hook produces (rate_limit_event, informational: the SDK's own typings).
const RETRY = { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 563, error_status: 529, error: 'overloaded', session_id: 'c1', uuid: '67c2e12a-e020-406a-b7b8-4d90df03dc10' }
const rateLimit = (info: Record<string, unknown>) => ({ type: 'rate_limit_event', rate_limit_info: info, session_id: 'c1', uuid: '8a2f7c1e-55a0-4d3b-9f1e-2b6c0d9e4a11' })
const informational = (level: string, content: string, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'informational', content, level, session_id: 'c1', uuid: 'f3b1c2d4-1e2f-4a3b-8c4d-5e6f7a8b9c0d', ...extra })

describe('framesForSdkMessage: provider events that never end a turn', () => {
  it('an API retry becomes sdk.retry with its attempt, limit, delay and error', () => {
    expect(framesForSdkMessage('s1', RETRY, session())).toEqual([
      { type: 'sdk.retry', sessionId: 's1', attempt: 1, maxRetries: 10, delayMs: 563, errorStatus: 529, error: 'overloaded' },
    ])
    // A connection error (a timeout) had no HTTP status.
    expect(framesForSdkMessage('s1', { ...RETRY, attempt: 3, error_status: null, error: 'unknown' }, session())[0])
      .toMatchObject({ attempt: 3, errorStatus: null, error: 'unknown' })
  })

  it('a rate limit warning or rejection becomes a notice carrying the limit; an allowed status says nothing', () => {
    expect(framesForSdkMessage('s1', rateLimit({ status: 'allowed', resetsAt: 1761300000 }), session())).toEqual([])
    expect(framesForSdkMessage('s1', rateLimit({ status: 'allowed_warning', resetsAt: 1761300000, rateLimitType: 'five_hour', utilization: 0.92, isUsingOverage: false }), session())).toEqual([
      {
        type: 'sdk.notice',
        sessionId: 's1',
        level: 'warning',
        code: 'RATE_LIMIT_WARNING',
        message: expect.any(String),
        rateLimit: { status: 'allowed_warning', resetsAt: 1761300000, rateLimitType: 'five_hour', utilization: 0.92 },
      },
    ])
    const [rejected] = framesForSdkMessage('s1', rateLimit({ status: 'rejected', resetsAt: 1761300000, rateLimitType: 'seven_day' }), session())
    expect(rejected).toMatchObject({ type: 'sdk.notice', level: 'error', code: 'RATE_LIMITED', rateLimit: { status: 'rejected', resetsAt: 1761300000, rateLimitType: 'seven_day' } })
    expect(rejected.rateLimit).not.toHaveProperty('utilization')
    expect(rejected.message).not.toBe(framesForSdkMessage('s1', rateLimit({ status: 'allowed_warning' }), session())[0].message)
  })

  it('a warning or suggestion the CLI shows prominently becomes a notice with its text', () => {
    expect(framesForSdkMessage('s1', informational('warning', '  A hook blocked this prompt.\n'), session())).toEqual([
      { type: 'sdk.notice', sessionId: 's1', level: 'warning', code: 'INFORMATIONAL', message: 'A hook blocked this prompt.' },
    ])
    expect(framesForSdkMessage('s1', informational('suggestion', 'Try /compact'), session())).toEqual([
      { type: 'sdk.notice', sessionId: 's1', level: 'info', code: 'INFORMATIONAL', message: 'Try /compact' },
    ])
    expect(framesForSdkMessage('s1', informational('warning', '   '), session())).toEqual([])
  })

  it('the CLI\'s quiet informational chatter (info, notice, per-tool progress) is no notice', () => {
    for (const level of ['info', 'notice', undefined]) {
      expect(framesForSdkMessage('s1', informational(level as string, 'Plain status'), session())).toEqual([])
    }
    expect(framesForSdkMessage('s1', informational('info', 'Reading files…', { tool_use_id: 'toolu_1' }), session())).toEqual([])
  })

  it('a quiet message that stops the turn is still a warning notice', () => {
    expect(framesForSdkMessage('s1', informational('notice', 'A Stop hook ended the turn.', { prevent_continuation: true }), session())).toEqual([
      { type: 'sdk.notice', sessionId: 's1', level: 'warning', code: 'INFORMATIONAL', message: 'A Stop hook ended the turn.' },
    ])
  })
})

describe('frameLogRecord', () => {
  it('logs a retry as a warning with its numbers', () => {
    const [frame] = framesForSdkMessage('s1', RETRY, session())
    expect(frameLogRecord(frame)).toEqual({ severity: 'warn', event: 'api.retry', fields: { sessionId: 's1', attempt: 1, maxRetries: 10, delayMs: 563, errorStatus: 529, error: 'overloaded' } })
  })

  it('logs a notice at its level, with the limit for a rate limit and only the size of an informational text', () => {
    const [warning] = framesForSdkMessage('s1', rateLimit({ status: 'allowed_warning', resetsAt: 1761300000, rateLimitType: 'five_hour', utilization: 0.92 }), session())
    expect(frameLogRecord(warning)).toEqual({ severity: 'warn', event: 'notice', fields: { sessionId: 's1', code: 'RATE_LIMIT_WARNING', rateLimitStatus: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 1761300000 } })
    const [rejected] = framesForSdkMessage('s1', rateLimit({ status: 'rejected' }), session())
    expect(frameLogRecord(rejected)).toMatchObject({ severity: 'error', event: 'notice', fields: { code: 'RATE_LIMITED' } })
    const [info] = framesForSdkMessage('s1', informational('suggestion', 'text a hook wrote'), session())
    const record = frameLogRecord(info)
    expect(record).toEqual({ severity: 'info', event: 'notice', fields: { sessionId: 's1', code: 'INFORMATIONAL', bytes: 17 } })
    expect(JSON.stringify(record)).not.toContain('hook wrote')
  })

  it('logs nothing for content frames', () => {
    for (const { frames } of mapRecording('tools-sync')) {
      for (const frame of frames) expect(frameLogRecord(frame)).toBeUndefined()
    }
  })
})

describe('framesForSdkMessage: what a status frame reports besides compacting', () => {
  const compactEnd = (scenario: string) => recorded(scenario).find((msg) => msg.type === 'system' && msg.subtype === 'status' && msg.status === null && msg.compact_result)!

  it('a failed compaction is a notice with the CLI\'s reason; the turn that ran it is running again', () => {
    expect(framesForSdkMessage('s1', compactEnd('compact-fail'), session(undefined, { turnPending: true }))).toEqual([
      { type: 'sdk.notice', sessionId: 's1', level: 'error', code: 'COMPACTION_FAILED', message: 'Error during compaction: API Error: 400 compaction refused by fake' },
      { type: 'sdk.status', sessionId: 's1', status: 'running' },
    ])
  })

  it('a finished compaction reports running only while a send is still waiting for its result', () => {
    expect(framesForSdkMessage('s1', compactEnd('compact-ok'), session(undefined, { turnPending: true })))
      .toEqual([{ type: 'sdk.status', sessionId: 's1', status: 'running' }])
    expect(framesForSdkMessage('s1', compactEnd('compact-ok'), session(undefined, { turnPending: false }))).toEqual([])
    expect(framesForSdkMessage('s1', compactEnd('compact-fail'), session(undefined, { turnPending: false })).map((frame: Msg) => frame.type)).toEqual(['sdk.notice'])
  })

  it('a failed compaction with no reason still says what failed', () => {
    const [notice] = framesForSdkMessage('s1', { type: 'system', subtype: 'status', status: null, compact_result: 'failed', uuid: 'x' }, session())
    expect(notice).toMatchObject({ code: 'COMPACTION_FAILED', level: 'error', message: expect.stringMatching(/\S/) })
  })

  it('a permission mode the CLI reports that differs from the session\'s becomes sdk.session.metadata (F12: after ExitPlanMode)', () => {
    const planExit = { type: 'system', subtype: 'status', status: null, permissionMode: 'default', uuid: '27298f9c-df16-4cbd-a017-e33c7b518c0b', session_id: 'c1' }
    expect(framesForSdkMessage('s1', planExit, session(undefined, { permissionMode: 'plan' }))).toEqual([
      { type: 'sdk.session.metadata', sessionId: 's1', permissionMode: 'default' },
    ])
    // The mode the session already has, or none at all, states nothing; a
    // status frame that ends no compaction is no reason to say running.
    expect(framesForSdkMessage('s1', planExit, session(undefined, { permissionMode: 'default' }))).toEqual([])
    expect(framesForSdkMessage('s1', { ...planExit, permissionMode: undefined }, session(undefined, { permissionMode: 'plan' }))).toEqual([])
  })

  it('logs a failed compaction as an error with its reason, and a permission mode change at info', () => {
    const [notice] = framesForSdkMessage('s1', compactEnd('compact-fail'), session())
    expect(frameLogRecord(notice)).toEqual({ severity: 'error', event: 'notice', fields: { sessionId: 's1', code: 'COMPACTION_FAILED', error: 'Error during compaction: API Error: 400 compaction refused by fake' } })
    expect(frameLogRecord({ type: 'sdk.session.metadata', sessionId: 's1', permissionMode: 'default' }))
      .toEqual({ severity: 'info', event: 'permission_mode.changed', fields: { sessionId: 's1', permissionMode: 'default' } })
    expect(frameLogRecord({ type: 'sdk.status', sessionId: 's1', status: 'running' })).toBeUndefined()
  })
})
