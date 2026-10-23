import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { FreshAgentSnapshotSchema, type FreshAgentSnapshot } from '@shared/fresh-agent-contract'
import freshAgentReducer from '@/store/freshAgentSlice'
import freshAgentLiveReducer, { transcriptLanded } from '@/store/freshAgentLiveSlice'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import { streamBatcherFor } from '@/lib/fresh-agent-stream-batcher'
import { landedTranscriptOf } from '@/lib/fresh-agent-landed-transcript'
import {
  createFrameState,
  framesForSdkMessage,
} from '../../../../crates/freshell-claude-sidecar/sdk-message-frames.mjs'

// The live tail's landing rules against what the pinned real CLI produced
// (test/fixtures/fresh-agent/claude/real-cli-2.1.237/tools-sync): the SDK
// messages it emitted, mapped by the real sidecar mapper, against the
// snapshot the server projects from the transcript it wrote.

const SCENARIO = path.resolve(__dirname, '../../../fixtures/fresh-agent/claude/real-cli-2.1.237/tools-sync')
const locator = { sessionId: 'real-cli-tools-sync', sessionType: 'freshclaude' as const, provider: 'claude' as const }
const KEY = 'freshclaude:claude:real-cli-tools-sync'

type Msg = Record<string, any>

function recorded(): Msg[] {
  return fs.readFileSync(path.join(SCENARIO, 'sdk.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).msg as Msg)
}

function goldenSnapshot(): FreshAgentSnapshot {
  return FreshAgentSnapshotSchema.parse(JSON.parse(fs.readFileSync(path.join(SCENARIO, 'snapshot.golden.json'), 'utf8')))
}

/** The server's rename of the sidecar frames the live tail reads (sdk.* → freshAgent.*). */
const RENAMED: Record<string, string> = {
  'sdk.stream': 'freshAgent.stream',
  'sdk.assistant': 'freshAgent.assistant',
  'sdk.session.changed': 'freshAgent.session.changed',
}

/** Replays the recorded turn into a store through the real sidecar mapping and websocket handler. */
function replay({ dropAssistantFrames }: { dropAssistantFrames: boolean }) {
  const store = configureStore({ reducer: { freshAgent: freshAgentReducer, freshAgentLive: freshAgentLiveReducer } })
  const session = { stream: createFrameState(), permissionMode: 'bypassPermissions', turnPending: true }
  for (const msg of recorded()) {
    for (const frame of framesForSdkMessage(locator.sessionId, msg, session) as Msg[]) {
      const type = RENAMED[frame.type]
      if (!type || (dropAssistantFrames && type === 'freshAgent.assistant')) continue
      handleFreshAgentMessage(store.dispatch, { type: 'freshAgent.event', ...locator, event: { ...frame, type } })
    }
  }
  streamBatcherFor(store.dispatch).flush()
  return store
}

describe('live tail landing against the real CLI (transcript-live D9)', () => {
  it('lists each API message\'s lines in block order, as the CLI wrote them', () => {
    const landed = landedTranscriptOf(goldenSnapshot())
    expect(landed.messageBlockKinds.msg_fixture0001).toEqual(['thinking', 'text', 'tool_use'])
    // A subagent's tool line is projected as its delegation and still counts as the tool block.
    expect(landed.messageBlockKinds.msg_fixture0006).toEqual(['tool_use'])
  })

  it('streams one block per content block of the main thread and binds each to the line the CLI wrote', () => {
    const store = replay({ dropAssistantFrames: false })
    const blocks = store.getState().freshAgentLive.bySession[KEY].blocks
    expect(blocks.map((block) => `${block.messageId}:${block.index}:${block.kind}`)).toEqual([
      'msg_fixture0001:0:thinking', 'msg_fixture0001:1:text', 'msg_fixture0001:2:tool_use',
      'msg_fixture0002:0:tool_use', 'msg_fixture0003:0:tool_use', 'msg_fixture0004:0:tool_use',
      'msg_fixture0005:0:tool_use', 'msg_fixture0006:0:tool_use', 'msg_fixture0009:0:text',
    ])
    const snapshotTurnIds = new Set(goldenSnapshot().turns.map((turn) => turn.turnId))
    expect(blocks.every((block) => block.uuid !== undefined && snapshotTurnIds.has(block.uuid))).toBe(true)
  })

  it.each([
    ['by their line uuids', false],
    ['by message position when every assistant frame was lost', true],
  ])('lands every streamed block once the snapshot holds the turn (%s)', (_label, dropAssistantFrames) => {
    const store = replay({ dropAssistantFrames })
    expect(store.getState().freshAgentLive.bySession[KEY].blocks).toHaveLength(9)
    const landed = landedTranscriptOf(goldenSnapshot())
    store.dispatch(transcriptLanded({ sessionKey: KEY, present: [...landed.lineIds], messageBlockKinds: landed.messageBlockKinds }))
    const tail = store.getState().freshAgentLive.bySession[KEY]
    expect(tail.blocks).toEqual([])
    expect(tail.expectedTurnIds).toEqual([])
  })
})
