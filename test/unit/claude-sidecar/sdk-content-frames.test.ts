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
