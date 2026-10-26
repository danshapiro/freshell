import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import { isLiveBlockLanded, landedTranscript, type LandedTranscript } from '@/lib/fresh-agent-landed-transcript'
import { applyFreshAgentTranscriptPatch, bindTranscriptProjection, freezeTranscriptProjection, hydrateTranscriptProjection, readTranscriptProjection } from '@/lib/fresh-agent-transcript-projection'
import type { FreshAgentSnapshot, FreshAgentTranscriptPatch } from '@shared/fresh-agent-contract'
import {
  markSessionLost,
  materializeSession,
  removeSession,
  sessionError,
  sessionExited,
  setSessionStatus,
  turnResult,
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
  viewers: {},
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

function retireRetainedSource(session: FreshAgentLiveSession): void {
  if (session.retainedSourceKey) {
    session.retiredRetainedSourceKeys ??= {}
    session.retiredRetainedSourceKeys[session.retainedSourceKey] = true
  }
  delete session.retainedSourceKey
  delete session.retainedSnapshot
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
  delete session.unboundTranscriptPatches
  delete session.unboundTranscriptWatermarks
  if (session.projection) session.projection = freezeTranscriptProjection(session.projection)
}

function clearTailsFor(state: FreshAgentLiveState, payload: SessionMutationPayload): void {
  for (const key of tailKeysFor(state, payload)) clearTail(state.bySession[key])
}

function isViewed(state: FreshAgentLiveState, key: string): boolean {
  return (state.viewers[key] ?? 0) > 0
}

/**
 * The session's turn ended (its result, or an idle status). A tail a visible
 * pane settles keeps its blocks, marked ended, until their lines land; the
 * retry is over. A tail no pane settles is dropped: nothing would ever land it.
 */
function endTurnsFor(state: FreshAgentLiveState, payload: SessionMutationPayload): void {
  for (const key of tailKeysFor(state, payload)) {
    if (!isViewed(state, key) && !state.bySession[key].projection) {
      delete state.bySession[key]
      continue
    }
    const session = state.bySession[key]
    for (const block of session.blocks) if (!block.ended) block.ended = true
    if (session.retry) delete session.retry
  }
}

/**
 * A session error (not a restore failure). It may end the turn (a failed
 * turn's error follows its result) or not (a refused configure mid-turn), so
 * a settled tail keeps every block and every line its pane waits for: they
 * land, or the pane clears them, as at any turn's end. Only the retry is over.
 */
function errorTailsFor(state: FreshAgentLiveState, payload: SessionMutationPayload): void {
  for (const key of tailKeysFor(state, payload)) {
    if (!isViewed(state, key)) delete state.bySession[key]
    else if (state.bySession[key].retry) delete state.bySession[key].retry
  }
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
    /** Authoritative init/snapshot binding; arbitrary patches cannot change incarnation. */
    transcriptProjectionBound(state, action: PayloadAction<FreshAgentSessionLocator & { projectionId: string; historyGeneration: number }>) {
      const { projectionId, historyGeneration, ...locator } = action.payload
      const session = sessionFor(state, locator)
      const previous = session.projection
      // A later incarnation is accepted through the view's fenced snapshot
      // request. Delayed init frames cannot replace an already-bound source.
      if (previous && previous.id !== projectionId) return
      if (previous?.id === projectionId && previous.historyGeneration >= historyGeneration) return
      session.projection = bindTranscriptProjection(previous, projectionId, historyGeneration)
      for (const patch of session.unboundTranscriptPatches ?? []) {
        if (patch.projectionId === projectionId) session.projection = applyFreshAgentTranscriptPatch(session.projection, patch)
      }
      const watermark = session.unboundTranscriptWatermarks?.[JSON.stringify([projectionId, historyGeneration])]
      if (watermark?.gap) {
        session.projection.needsResnapshot = true
        session.projection.eventRevision = Math.max(session.projection.eventRevision, watermark.revision)
      }
      delete session.unboundTranscriptPatches
      delete session.unboundTranscriptWatermarks
    },
    transcriptPatchApplied(state, action: PayloadAction<FreshAgentSessionLocator & { patch: FreshAgentTranscriptPatch }>) {
      const { patch, ...locator } = action.payload
      const session = sessionFor(state, locator)
      if (session.projection?.id === patch.projectionId) session.projection = applyFreshAgentTranscriptPatch(session.projection, patch)
      else {
        // Buffer a bounded reconnect race without adopting its source. The
        // authoritative init/snapshot chooses which incarnation may replay.
        const pending = session.unboundTranscriptPatches ??= []
        const watermarks = session.unboundTranscriptWatermarks ??= {}
        const key = JSON.stringify([patch.projectionId, patch.historyGeneration])
        const watermark = watermarks[key] ??= { revision: 0, gap: false }
        watermark.revision = Math.max(watermark.revision, ...patch.ops.map((op) => op.revision))
        if (pending.length < 64 && JSON.stringify(pending).length + JSON.stringify(patch).length <= 64 * 1024) pending.push(patch)
        else watermark.gap = true
      }
    },
    transcriptProjectionSnapshotReceived(state, action: PayloadAction<FreshAgentSessionLocator & { snapshot: FreshAgentSnapshot; retainedSourceKey?: string }>) {
      const { snapshot, retainedSourceKey, ...locator } = action.payload
      const metadata = readTranscriptProjection(snapshot)
      if (!metadata) return
      const session = sessionFor(state, locator)
      if (session.retiredProjectionIds?.[metadata.id] === true) return
      if (retainedSourceKey) {
        if (session.retiredRetainedSourceKeys?.[retainedSourceKey] === true) return
        if (session.projection?.id === metadata.id && (session.projection.historyGeneration > metadata.historyGeneration
          || session.projection.historyGeneration === metadata.historyGeneration && session.projection.eventRevision > metadata.eventRevision)) return
        if (session.retainedSourceKey && session.retainedSourceKey !== retainedSourceKey) {
          retireRetainedSource(session)
        }
        session.retainedSourceKey = retainedSourceKey
        session.retainedSnapshot = snapshot
      }
      if (session.projection && session.projection.id !== metadata.id) {
        session.retiredProjectionIds ??= {}
        session.retiredProjectionIds[session.projection.id] = true
        if (!retainedSourceKey) retireRetainedSource(session)
      }
      if (!session.projection || session.projection.id !== metadata.id || session.projection.historyGeneration < metadata.historyGeneration) {
        session.projection = bindTranscriptProjection(session.projection, metadata.id, metadata.historyGeneration)
      }
      session.projection = hydrateTranscriptProjection(session.projection, snapshot)
      for (const patch of session.unboundTranscriptPatches ?? []) {
        if (patch.projectionId === metadata.id) session.projection = applyFreshAgentTranscriptPatch(session.projection, patch)
      }
      const watermark = session.unboundTranscriptWatermarks?.[JSON.stringify([metadata.id, metadata.historyGeneration])]
      if (watermark?.gap && metadata.eventRevision < watermark.revision) {
        session.projection.needsResnapshot = true
        session.projection.eventRevision = Math.max(session.projection.eventRevision, watermark.revision)
      }
      delete session.unboundTranscriptPatches
      delete session.unboundTranscriptWatermarks
      const projection = session.projection
      if (projection.historyGeneration !== metadata.historyGeneration) return
      const accepted = new Set([...metadata.eventOwnedTurnIds, ...metadata.nativePreviewTurnIds, ...metadata.nativeFinalTurnIds])
      for (const id of Object.keys(projection.frozenTurns ?? {})) if (!accepted.has(id)) delete projection.frozenTurns![id]
      for (const id of metadata.nativeFinalTurnIds ?? []) {
        (projection.settledTurns ??= {})[id] = true
        const rows = new Set(projection.turnRows?.[id] ?? [])
        projection.turns = projection.turns.filter((row) => !rows.has(row.turnId))
        if (projection.turnRows) delete projection.turnRows[id]
        if (metadata.turnOutputStates[id]?.diagnostic !== 'interrupted' && projection.frozenTurns) delete projection.frozenTurns[id]
      }
    },
    codexMetadataReceived(state, action: PayloadAction<FreshAgentSessionLocator & { metadata: Record<string, unknown> }>) {
      const { metadata, ...locator } = action.payload
      sessionFor(state, locator).codexMetadata = metadata
    },
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

    /**
     * The pane's ended turn has landed: its blocks and the lines it awaited
     * are done. A block of a turn still streaming stays (the pane can believe
     * the session idle while the CLI streams on, after a refused configure).
     */
    liveTailCleared(state, action: PayloadAction<{ sessionKey: string }>) {
      const session = state.bySession[action.payload.sessionKey]
      if (!session) return
      if (session.blocks.some((block) => block.ended)) session.blocks = session.blocks.filter((block) => !block.ended)
      if (session.expectedTurnIds.length > 0) session.expectedTurnIds = []
    },

    /** A visible pane now settles this session's tail. */
    liveTailViewerAdded(state, action: PayloadAction<{ sessionKey: string }>) {
      const { sessionKey } = action.payload
      state.viewers[sessionKey] = (state.viewers[sessionKey] ?? 0) + 1
    },

    /**
     * A pane stopped settling this session's tail (it hid, closed or
     * remounted). Nothing is dropped here: a remount re-adds itself at once,
     * and the turn's end drops a tail no pane settles.
     */
    liveTailViewerRemoved(state, action: PayloadAction<{ sessionKey: string }>) {
      const { sessionKey } = action.payload
      const count = state.viewers[sessionKey] ?? 0
      if (count > 1) state.viewers[sessionKey] = count - 1
      else if (count === 1) delete state.viewers[sessionKey]
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
        if (action.payload.status === 'exited' || action.payload.status === 'stuck') clearTailsFor(state, action.payload)
        // Idle ends the turn but clears nothing a pane settles: the pane clears
        // the tail once the turn's lines landed, so the text never blinks out
        // between the result and the snapshot.
        else if (action.payload.status === 'idle') endTurnsFor(state, action.payload)
      })
      .addCase(turnResult, (state, action) => endTurnsFor(state, action.payload))
      .addCase(sessionError, (state, action) => {
        if (!action.payload.code?.startsWith('RESTORE_')) errorTailsFor(state, action.payload)
      })
  },
})

export const {
  transcriptProjectionBound,
  transcriptPatchApplied,
  transcriptProjectionSnapshotReceived,
  codexMetadataReceived,
  assistantBlockBound,
  liveNoticeReceived,
  liveRetrySet,
  liveTailCleared,
  liveTailViewerAdded,
  liveTailViewerRemoved,
  streamOpsApplied,
  transcriptAnnounced,
  transcriptExpectationsDropped,
  transcriptLanded,
} = freshAgentLiveSlice.actions

export default freshAgentLiveSlice.reducer
