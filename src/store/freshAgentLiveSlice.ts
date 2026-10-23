import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import type { FreshAgentSessionLocator } from './freshAgentTypes'
import type {
  FreshAgentLiveSession,
  FreshAgentLiveState,
  LiveStreamOp,
} from './freshAgentLiveTypes'

const initialState: FreshAgentLiveState = {
  bySession: {},
  noticeSeq: 0,
}

function emptySession(): FreshAgentLiveSession {
  return { blocks: [], expectedTurnIds: [] }
}

function applyStreamOp(session: FreshAgentLiveSession, op: LiveStreamOp): void {
  const existing = session.blocks.find((block) => block.messageId === op.messageId && block.index === op.index)
  if (op.op === 'start') {
    if (existing) return
    session.blocks.push({
      messageId: op.messageId,
      index: op.index,
      kind: op.kind,
      text: '',
      ...(op.name !== undefined ? { name: op.name } : {}),
      ...(op.toolUseId !== undefined ? { toolUseId: op.toolUseId } : {}),
    })
    return
  }
  // A delta whose block start this client never saw (it attached mid-block)
  // has nothing to extend: the snapshot shows the block once it lands.
  if (!existing) return
  existing.text += op.text
}

const freshAgentLiveSlice = createSlice({
  name: 'freshAgentLive',
  initialState,
  reducers: {
    /** A batch of stream events for one session, in arrival order. */
    streamOpsApplied(state, action: PayloadAction<FreshAgentSessionLocator & { ops: LiveStreamOp[] }>) {
      const { ops, ...locator } = action.payload
      if (ops.length === 0) return
      const key = makeFreshAgentSessionKey(locator)
      const session = state.bySession[key] ?? emptySession()
      for (const op of ops) applyStreamOp(session, op)
      state.bySession[key] = session
    },
  },
})

export const { streamOpsApplied } = freshAgentLiveSlice.actions

export default freshAgentLiveSlice.reducer
