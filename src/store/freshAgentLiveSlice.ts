import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import { isLiveBlockLanded, landedTranscript, type LandedTranscript } from '@/lib/fresh-agent-landed-transcript'
import {
  markSessionLost,
  materializeSession,
  removeSession,
  sessionError,
  sessionExited,
  setSessionStatus,
} from './freshAgentSlice'
import type { FreshAgentSessionLocator } from './freshAgentTypes'
import type {
  FreshAgentLiveSession,
  FreshAgentLiveState,
  LiveBlock,
  LiveBlockKind,
  LiveNotice,
  LiveRetry,
  LiveStreamOp,
} from './freshAgentLiveTypes'

const initialState: FreshAgentLiveState = {
  bySession: {},
  noticeSeq: 0,
}

/** The payload shape of the freshAgent session actions this slice follows. */
type SessionMutationPayload = {
  sessionId: string
  sessionType?: FreshAgentSessionLocator['sessionType']
  provider?: FreshAgentSessionLocator['provider']
}

function emptySession(): FreshAgentLiveSession {
  return { blocks: [], expectedTurnIds: [] }
}

function sessionFor(state: FreshAgentLiveState, locator: FreshAgentSessionLocator): FreshAgentLiveSession {
  const key = makeFreshAgentSessionKey(locator)
  state.bySession[key] ??= emptySession()
  return state.bySession[key]
}

/** Session keys are `${sessionType}:${provider}:${sessionId}`; the id may itself contain ':'. */
function sessionIdOfKey(key: string): string {
  return key.split(':').slice(2).join(':')
}

/**
 * The tails a freshAgent session action names: its exact key when it carries
 * the full locator, else every tail of that session id (the sessions slice
 * resolves such payloads the same way).
 */
function tailKeysFor(state: FreshAgentLiveState, payload: SessionMutationPayload): string[] {
  if (payload.sessionType && payload.provider) {
    const key = makeFreshAgentSessionKey({ sessionId: payload.sessionId, sessionType: payload.sessionType, provider: payload.provider })
    return state.bySession[key] ? [key] : []
  }
  return Object.keys(state.bySession).filter((key) => sessionIdOfKey(key) === payload.sessionId)
}

function clearTail(session: FreshAgentLiveSession): void {
  if (session.blocks.length > 0) session.blocks = []
  if (session.expectedTurnIds.length > 0) session.expectedTurnIds = []
  if (session.retry) delete session.retry
}

function clearTailsFor(state: FreshAgentLiveState, payload: SessionMutationPayload): void {
  for (const key of tailKeysFor(state, payload)) clearTail(state.bySession[key])
}

function applyStreamOp(session: FreshAgentLiveSession, op: LiveStreamOp): void {
  const existing = session.blocks.find((block) => block.messageId === op.messageId && block.index === op.index)
  if (op.op === 'start') {
    // The retried request is answering: the retry is over.
    if (session.retry) delete session.retry
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

const CONTENT_KINDS: ReadonlySet<string> = new Set<LiveBlockKind>(['text', 'thinking', 'tool_use'])

/** The completed block an assistant message carries (the CLI sends one per block, F2). */
function boundContent(content: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return content.find((block) => typeof block.type === 'string' && CONTENT_KINDS.has(block.type))
}

function bindBlock(block: LiveBlock, uuid: string, content: Record<string, unknown>): void {
  block.uuid = uuid
  // The message carries the whole block: it wins over whatever the stream delivered.
  if (block.kind === 'text' && typeof content.text === 'string') block.text = content.text
  if (block.kind === 'thinking' && typeof content.thinking === 'string') block.text = content.thinking
  if (block.kind === 'tool_use') {
    if (typeof content.name === 'string') block.name = content.name
    if (typeof content.id === 'string') block.toolUseId = content.id
    if (content.input !== undefined) block.input = content.input
  }
}

const freshAgentLiveSlice = createSlice({
  name: 'freshAgentLive',
  initialState,
  reducers: {
    /** A batch of stream events for one session, in arrival order. */
    streamOpsApplied(state, action: PayloadAction<FreshAgentSessionLocator & { ops: LiveStreamOp[] }>) {
      const { ops, ...locator } = action.payload
      if (ops.length === 0) return
      const session = sessionFor(state, locator)
      for (const op of ops) applyStreamOp(session, op)
    },

    /**
     * A main-thread assistant message: the transcript line `uuid` it becomes
     * belongs to the first streamed block of the same API message and kind
     * that has no line yet, so the tail can hide it once that line lands.
     */
    assistantBlockBound(state, action: PayloadAction<FreshAgentSessionLocator & {
      uuid: string
      messageId?: string
      content: Array<Record<string, unknown>>
    }>) {
      const { uuid, messageId, content, ...locator } = action.payload
      const tail = state.bySession[makeFreshAgentSessionKey(locator)]
      const block = boundContent(content)
      if (!tail || !block) return
      const target = tail.blocks.find((candidate) => (
        candidate.uuid === undefined
        && candidate.messageId === (messageId ?? null)
        && candidate.kind === block.type
      ))
      if (target) bindBlock(target, uuid, block)
    },

    /** The CLI will write this main-thread line to the transcript. */
    transcriptAnnounced(state, action: PayloadAction<FreshAgentSessionLocator & { uuid: string }>) {
      const { uuid, ...locator } = action.payload
      const session = sessionFor(state, locator)
      if (!session.expectedTurnIds.includes(uuid)) session.expectedTurnIds.push(uuid)
    },

    /**
     * A committed snapshot holds these lines: the blocks it shows (by uuid, or
     * by message id and position for a block whose uuid never arrived) and
     * the announced lines it holds are done.
     */
    transcriptLanded(state, action: PayloadAction<{
      sessionKey: string
      present: readonly string[]
      messageBlockKinds?: LandedTranscript['messageBlockKinds']
    }>) {
      const session = state.bySession[action.payload.sessionKey]
      if (!session) return
      const landed = landedTranscript(action.payload.present, action.payload.messageBlockKinds)
      if (session.blocks.some((block) => isLiveBlockLanded(block, landed))) {
        session.blocks = session.blocks.filter((block) => !isLiveBlockLanded(block, landed))
      }
      if (session.expectedTurnIds.some((uuid) => landed.lineIds.has(uuid))) {
        session.expectedTurnIds = session.expectedTurnIds.filter((uuid) => !landed.lineIds.has(uuid))
      }
    },

    /** The pane stopped re-polling for these lines (they never landed in time). */
    transcriptExpectationsDropped(state, action: PayloadAction<{ sessionKey: string; uuids: readonly string[] }>) {
      const session = state.bySession[action.payload.sessionKey]
      if (!session) return
      const dropped = new Set(action.payload.uuids)
      if (session.expectedTurnIds.some((uuid) => dropped.has(uuid))) {
        session.expectedTurnIds = session.expectedTurnIds.filter((uuid) => !dropped.has(uuid))
      }
    },

    /** The CLI is retrying a failed API request (shown until the next block starts). */
    liveRetrySet(state, action: PayloadAction<FreshAgentSessionLocator & LiveRetry>) {
      const { sessionId, sessionType, provider, ...retry } = action.payload
      sessionFor(state, { sessionId, sessionType, provider }).retry = retry
    },

    /**
     * A provider notice (rate limit, failed compaction, informational banner).
     * It never ends the turn or touches the session (P4); `seq` lets the pane
     * show each notice once, even when the same text repeats.
     */
    liveNoticeReceived(state, action: PayloadAction<FreshAgentSessionLocator & Omit<LiveNotice, 'seq'>>) {
      const { sessionId, sessionType, provider, ...notice } = action.payload
      state.noticeSeq += 1
      sessionFor(state, { sessionId, sessionType, provider }).notice = { seq: state.noticeSeq, ...notice }
    },

    /** The pane's turn has landed and ended: nothing live is left to show. */
    liveTailCleared(state, action: PayloadAction<{ sessionKey: string }>) {
      const session = state.bySession[action.payload.sessionKey]
      if (session) clearTail(session)
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(materializeSession, (state, action) => {
        const { previousSessionId, sessionId, sessionType, provider } = action.payload
        const previousKey = makeFreshAgentSessionKey({ sessionId: previousSessionId, sessionType, provider })
        const nextKey = makeFreshAgentSessionKey({ sessionId, sessionType, provider })
        const previous = state.bySession[previousKey]
        if (!previous || previousKey === nextKey) return
        state.bySession[nextKey] = previous
        delete state.bySession[previousKey]
      })
      .addCase(removeSession, (state, action) => {
        for (const key of tailKeysFor(state, action.payload)) delete state.bySession[key]
      })
      .addCase(sessionExited, (state, action) => clearTailsFor(state, action.payload))
      .addCase(markSessionLost, (state, action) => clearTailsFor(state, action.payload))
      .addCase(setSessionStatus, (state, action) => {
        // Idle is not here: the pane clears the tail once the turn's lines landed,
        // so the text never blinks out between the result and the snapshot.
        if (action.payload.status === 'exited' || action.payload.status === 'stuck') clearTailsFor(state, action.payload)
      })
      .addCase(sessionError, (state, action) => {
        if (!action.payload.code?.startsWith('RESTORE_')) clearTailsFor(state, action.payload)
      })
  },
})

export const {
  assistantBlockBound,
  liveNoticeReceived,
  liveRetrySet,
  liveTailCleared,
  streamOpsApplied,
  transcriptAnnounced,
  transcriptExpectationsDropped,
  transcriptLanded,
} = freshAgentLiveSlice.actions

export default freshAgentLiveSlice.reducer
