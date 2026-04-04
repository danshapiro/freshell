import { describe, it, expect } from 'vitest'
import agentChatReducer, {
  sessionCreated,
  registerPendingCreate,
  createFailed,
  clearPendingCreateFailure,
  sessionInit,
  sessionMetadataReceived,
  sessionSnapshotReceived,
  addAssistantMessage,
  addUserMessage,
  setStreaming,
  appendStreamDelta,
  clearStreaming,
  addPermissionRequest,
  removePermission,
  setSessionStatus,
  turnResult,
  sessionExited,
  timelinePageReceived,
  turnBodyReceived,
  sessionError,
  clearPendingCreate,
  removeSession,
  setAvailableModels,
} from '../../../src/store/agentChatSlice'

function makeChatMessage(role: 'user' | 'assistant', text: string) {
  return {
    role,
    content: [{ type: 'text' as const, text }],
    timestamp: '2026-03-10T10:01:00.000Z',
  }
}

function makeTimelineItem(
  turnId: string,
  role: 'user' | 'assistant',
  summary: string,
  overrides: Partial<{
    sessionId: string
    messageId: string
    ordinal: number
    source: 'durable' | 'live'
    timestamp: string
  }> = {},
) {
  return {
    turnId,
    messageId: overrides.messageId ?? `message:${turnId}`,
    ordinal: overrides.ordinal ?? 0,
    source: overrides.source ?? 'durable',
    sessionId: overrides.sessionId ?? 'sess-timeline',
    role,
    summary,
    ...(overrides.timestamp ? { timestamp: overrides.timestamp } : {}),
  }
}

function makeTimelineTurn(
  turnId: string,
  role: 'user' | 'assistant',
  text: string,
  overrides: Partial<{
    sessionId: string
    messageId: string
    ordinal: number
    source: 'durable' | 'live'
  }> = {},
) {
  return {
    sessionId: overrides.sessionId ?? 'sess-timeline',
    turnId,
    messageId: overrides.messageId ?? `message:${turnId}`,
    ordinal: overrides.ordinal ?? 0,
    source: overrides.source ?? 'durable',
    message: makeChatMessage(role, text),
  }
}

describe('agentChatSlice', () => {
  const initial = agentChatReducer(undefined, { type: 'init' })

  it('has empty initial state', () => {
    expect(initial.sessions).toEqual({})
    expect(initial.availableModels).toEqual([])
  })

  it('creates a session', () => {
    const state = agentChatReducer(initial, sessionCreated({
      requestId: 'req-1',
      sessionId: 'sess-1',
    }))
    expect(state.sessions['sess-1']).toBeDefined()
    expect(state.sessions['sess-1'].messages).toEqual([])
    expect(state.sessions['sess-1'].status).toBe('starting')
  })

  it('initializes session with CLI details', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = agentChatReducer(state, sessionInit({
      sessionId: 's1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
      cwd: '/home/user',
      tools: [{ name: 'Bash' }],
    }))
    expect(state.sessions['s1'].cliSessionId).toBe('cli-abc')
    expect(state.sessions['s1'].model).toBe('claude-opus-4-6')
    expect(state.sessions['s1'].status).toBe('connected')
  })

  it('stores user messages', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = agentChatReducer(state, addUserMessage({ sessionId: 's1', text: 'Hello' }))
    expect(state.sessions['s1'].messages).toHaveLength(1)
    expect(state.sessions['s1'].messages[0].role).toBe('user')
    expect(state.sessions['s1'].status).toBe('running')
  })

  it('stores assistant messages', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = agentChatReducer(state, addAssistantMessage({
      sessionId: 's1',
      content: [{ type: 'text', text: 'Hello' }],
      model: 'claude-sonnet-4-5-20250929',
    }))
    expect(state.sessions['s1'].messages).toHaveLength(1)
    expect(state.sessions['s1'].messages[0].role).toBe('assistant')
  })

  it('tracks streaming text', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = agentChatReducer(state, setStreaming({ sessionId: 's1', active: true }))
    state = agentChatReducer(state, appendStreamDelta({ sessionId: 's1', text: 'Hel' }))
    state = agentChatReducer(state, appendStreamDelta({ sessionId: 's1', text: 'lo' }))
    expect(state.sessions['s1'].streamingText).toBe('Hello')
    expect(state.sessions['s1'].streamingActive).toBe(true)
  })

  it('clears streaming state', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = agentChatReducer(state, setStreaming({ sessionId: 's1', active: true }))
    state = agentChatReducer(state, appendStreamDelta({ sessionId: 's1', text: 'Hello' }))
    state = agentChatReducer(state, clearStreaming({ sessionId: 's1' }))
    expect(state.sessions['s1'].streamingText).toBe('')
    expect(state.sessions['s1'].streamingActive).toBe(false)
  })

  it('can mark streaming inactive without discarding the partial preview text', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = agentChatReducer(state, setStreaming({ sessionId: 's1', active: true }))
    state = agentChatReducer(state, appendStreamDelta({ sessionId: 's1', text: 'Hello' }))
    state = agentChatReducer(state, setStreaming({ sessionId: 's1', active: false }))
    expect(state.sessions['s1'].streamingText).toBe('Hello')
    expect(state.sessions['s1'].streamingActive).toBe(false)
  })

  it('tracks permission requests', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = agentChatReducer(state, addPermissionRequest({
      sessionId: 's1',
      requestId: 'perm-1',
      subtype: 'can_use_tool',
      tool: { name: 'Bash', input: { command: 'ls' } },
    }))
    expect(state.sessions['s1'].pendingPermissions['perm-1']).toBeDefined()
    state = agentChatReducer(state, removePermission({ sessionId: 's1', requestId: 'perm-1' }))
    expect(state.sessions['s1'].pendingPermissions['perm-1']).toBeUndefined()
  })

  it('accumulates cost on result', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = agentChatReducer(state, turnResult({
      sessionId: 's1',
      costUsd: 0.05,
      durationMs: 3000,
      usage: { input_tokens: 1000, output_tokens: 500 },
    }))
    expect(state.sessions['s1'].totalCostUsd).toBe(0.05)
    expect(state.sessions['s1'].totalInputTokens).toBe(1000)
    expect(state.sessions['s1'].status).toBe('idle')
  })

  it('handles session exit', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = agentChatReducer(state, sessionExited({ sessionId: 's1', exitCode: 0 }))
    expect(state.sessions['s1'].status).toBe('exited')
  })

  it('ignores actions for unknown sessions', () => {
    const state = agentChatReducer(initial, addUserMessage({ sessionId: 'nonexistent', text: 'hello' }))
    expect(state).toEqual(initial)
  })

  it('sets historyLoaded on sessionCreated (fresh create)', () => {
    const state = agentChatReducer(initial, sessionCreated({
      requestId: 'req-1',
      sessionId: 'sess-1',
    }))
    expect(state.sessions['sess-1'].historyLoaded).toBe(true)
  })

  it('records pending create intent before sdk.created', () => {
    const state = agentChatReducer(initial, registerPendingCreate({
      requestId: 'resume-req',
      expectsHistoryHydration: true,
    }))

    expect(state.pendingCreates['resume-req']).toEqual({
      expectsHistoryHydration: true,
      sessionId: undefined,
    })
  })

  it('records request-scoped create failures by requestId', () => {
    const state = agentChatReducer(initial, createFailed({
      requestId: 'req-failed',
      code: 'RESTORE_INTERNAL',
      message: 'boom',
      retryable: true,
    }))

    expect((state as any).pendingCreateFailures['req-failed']).toEqual({
      code: 'RESTORE_INTERNAL',
      message: 'boom',
      retryable: true,
    })
  })

  it('clears request-scoped create failures independently of session state', () => {
    let state = agentChatReducer(initial, createFailed({
      requestId: 'req-failed',
      code: 'RESTORE_INTERNAL',
      message: 'boom',
      retryable: true,
    }))
    state = agentChatReducer(state, clearPendingCreateFailure({ requestId: 'req-failed' }))

    expect((state as any).pendingCreateFailures['req-failed']).toBeUndefined()
  })

  it('marks a fresh create as history-loaded immediately', () => {
    let state = agentChatReducer(initial, registerPendingCreate({
      requestId: 'fresh-req',
      expectsHistoryHydration: false,
    }))
    state = agentChatReducer(state, sessionCreated({
      requestId: 'fresh-req',
      sessionId: 'sdk-fresh',
    }))

    expect(state.sessions['sdk-fresh'].historyLoaded).toBe(true)
  })

  it('keeps a resumed create restoring until durable history is known', () => {
    let state = agentChatReducer(initial, registerPendingCreate({
      requestId: 'resume-req',
      expectsHistoryHydration: true,
    }))
    state = agentChatReducer(state, sessionCreated({
      requestId: 'resume-req',
      sessionId: 'sdk-resume',
    }))

    expect(state.sessions['sdk-resume'].historyLoaded).toBe(false)
  })

  it('keeps a named-resume create restoring when a pre-init snapshot has no latest turn yet', () => {
    let state = agentChatReducer(initial, registerPendingCreate({
      requestId: 'resume-empty',
      expectsHistoryHydration: true,
    }))
    state = agentChatReducer(state, sessionCreated({
      requestId: 'resume-empty',
      sessionId: 'sdk-empty',
    }))
    state = agentChatReducer(state, sessionSnapshotReceived({
      sessionId: 'sdk-empty',
      latestTurnId: null,
      status: 'starting',
      timelineSessionId: 'named-resume',
    }))

    expect(state.sessions['sdk-empty'].historyLoaded).toBe(false)
    expect(state.sessions['sdk-empty'].awaitingDurableHistory).toBe(true)

    state = agentChatReducer(state, sessionInit({
      sessionId: 'sdk-empty',
      cliSessionId: '00000000-0000-4000-8000-000000000555',
    }))

    expect(state.sessions['sdk-empty'].historyLoaded).toBe(false)
    expect(state.sessions['sdk-empty'].cliSessionId).toBe('00000000-0000-4000-8000-000000000555')
  })

  it('ends restore mode immediately when an empty snapshot already knows the durable session id', () => {
    let state = agentChatReducer(initial, registerPendingCreate({
      requestId: 'resume-empty-durable',
      expectsHistoryHydration: true,
    }))
    state = agentChatReducer(state, sessionCreated({
      requestId: 'resume-empty-durable',
      sessionId: 'sdk-empty-durable',
    }))
    state = agentChatReducer(state, sessionSnapshotReceived({
      sessionId: 'sdk-empty-durable',
      latestTurnId: null,
      status: 'idle',
      timelineSessionId: '00000000-0000-4000-8000-000000000556',
    }))

    expect(state.sessions['sdk-empty-durable'].historyLoaded).toBe(true)
  })

  it('sets historyLoaded when the initial timeline window is empty', () => {
    const state = agentChatReducer(initial, timelinePageReceived({
      sessionId: 'sess-attach',
      items: [],
      nextCursor: null,
      revision: 1,
      replace: true,
    }))
    expect(state.sessions['sess-attach'].historyLoaded).toBe(true)
    expect(state.sessions['sess-attach'].timelineItems).toEqual([])
  })

  it('does not set historyLoaded on setSessionStatus alone', () => {
    const state = agentChatReducer(initial, setSessionStatus({
      sessionId: 'sess-status',
      status: 'idle',
    }))
    expect(state.sessions['sess-status'].historyLoaded).toBeUndefined()
  })

  it('stores a small session snapshot without marking history loaded', () => {
    const state = agentChatReducer(initial, sessionSnapshotReceived({
      sessionId: 'sess-snapshot',
      latestTurnId: 'turn-9',
      status: 'idle',
    }))

    expect(state.sessions['sess-snapshot'].status).toBe('idle')
    expect(state.sessions['sess-snapshot'].latestTurnId).toBe('turn-9')
    expect(state.sessions['sess-snapshot'].historyLoaded).toBeUndefined()
  })

  it('stores timelineSessionId, timelineRevision, and stream snapshot from sdk.session.snapshot', () => {
    const state = agentChatReducer(initial, sessionSnapshotReceived({
      sessionId: 'sdk-1',
      latestTurnId: 'turn-2',
      status: 'running',
      timelineSessionId: 'cli-1',
      revision: 12,
      streamingActive: true,
      streamingText: 'partial reply',
    }))

    expect(state.sessions['sdk-1']).toMatchObject({
      timelineSessionId: 'cli-1',
      timelineRevision: 12,
      streamingActive: true,
      streamingText: 'partial reply',
    })
  })

  it('does not let sessionInit downgrade a running snapshot back to connected', () => {
    let state = agentChatReducer(initial, sessionCreated({
      requestId: 'req-running',
      sessionId: 'sdk-running',
    }))
    state = agentChatReducer(state, sessionSnapshotReceived({
      sessionId: 'sdk-running',
      latestTurnId: 'turn-4',
      status: 'running',
      timelineSessionId: 'cli-running',
      streamingActive: true,
      streamingText: 'partial reply',
    }))
    state = agentChatReducer(state, sessionInit({
      sessionId: 'sdk-running',
      cliSessionId: 'cli-running',
      model: 'claude-opus-4-6',
    }))

    expect(state.sessions['sdk-running']).toMatchObject({
      status: 'running',
      cliSessionId: 'cli-running',
      streamingActive: true,
      streamingText: 'partial reply',
    })
  })

  it('updates authoritative metadata without reusing the readiness transition', () => {
    let state = agentChatReducer(initial, sessionCreated({
      requestId: 'req-meta',
      sessionId: 'sdk-meta',
    }))
    state = agentChatReducer(state, sessionSnapshotReceived({
      sessionId: 'sdk-meta',
      latestTurnId: 'turn-1',
      status: 'running',
      timelineSessionId: 'cli-meta',
      revision: 5,
    }))
    state = agentChatReducer(state, sessionMetadataReceived({
      sessionId: 'sdk-meta',
      cliSessionId: 'cli-meta',
      model: 'claude-sonnet-4-5-20250929',
      cwd: '/tmp/project',
      tools: [{ name: 'Bash' }],
    }))

    expect(state.sessions['sdk-meta']).toMatchObject({
      status: 'running',
      cliSessionId: 'cli-meta',
      model: 'claude-sonnet-4-5-20250929',
      cwd: '/tmp/project',
      tools: [{ name: 'Bash' }],
      timelineRevision: 5,
    })
  })

  it('restarts hydration when a canonical durable id arrives after a completed live-only restore', () => {
    let state = agentChatReducer(initial, registerPendingCreate({
      requestId: 'req-upgrade',
      expectsHistoryHydration: true,
    }))
    state = agentChatReducer(state, sessionCreated({
      requestId: 'req-upgrade',
      sessionId: 'sdk-live',
    }))
    state = agentChatReducer(state, sessionSnapshotReceived({
      sessionId: 'sdk-live',
      latestTurnId: 'turn-1',
      status: 'idle',
      timelineSessionId: 'named-resume',
      revision: 1,
    }))
    state = agentChatReducer(state, timelinePageReceived({
      sessionId: 'sdk-live',
      items: [
        makeTimelineItem('turn-1', 'assistant', 'Live-only summary', {
          sessionId: 'named-resume',
          ordinal: 0,
        }),
      ],
      nextCursor: null,
      revision: 1,
      replace: true,
    }))

    expect(state.sessions['sdk-live']).toMatchObject({
      historyLoaded: true,
      timelineSessionId: 'named-resume',
      timelineRevision: 1,
    })

    state = agentChatReducer(state, sessionMetadataReceived({
      sessionId: 'sdk-live',
      cliSessionId: '00000000-0000-4000-8000-000000000321',
    }))

    expect(state.sessions['sdk-live']).toMatchObject({
      historyLoaded: false,
      timelineSessionId: '00000000-0000-4000-8000-000000000321',
      latestTurnId: 'turn-1',
      restoreRetryCount: 0,
    })
    expect(state.sessions['sdk-live'].timelineRevision).toBeUndefined()
    expect(state.sessions['sdk-live'].timelineItems).toEqual([])
    expect(state.sessions['sdk-live'].timelineBodies).toEqual({})
    expect(state.sessions['sdk-live'].nextTimelineCursor).toBeUndefined()
  })

  it('stores timeline summaries and marks history loaded once the first page arrives', () => {
    const state = agentChatReducer(initial, timelinePageReceived({
      sessionId: 'sess-timeline',
      items: [
        makeTimelineItem('turn-2', 'assistant', 'Latest summary', {
          sessionId: 'sess-timeline',
          ordinal: 2,
          timestamp: '2026-03-10T10:01:00.000Z',
        }),
      ],
      nextCursor: 'cursor-2',
      revision: 2,
      replace: true,
    }))

    expect(state.sessions['sess-timeline'].historyLoaded).toBe(true)
    expect(state.sessions['sess-timeline'].timelineItems).toEqual([
      expect.objectContaining({ turnId: 'turn-2', summary: 'Latest summary' }),
    ])
    expect(state.sessions['sess-timeline'].nextTimelineCursor).toBe('cursor-2')
  })

  it('clears a stale streaming preview when the final assistant message is committed', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'req-stream', sessionId: 'sdk-stream' }))
    state = agentChatReducer(state, setStreaming({ sessionId: 'sdk-stream', active: true }))
    state = agentChatReducer(state, appendStreamDelta({ sessionId: 'sdk-stream', text: 'partial reply' }))
    state = agentChatReducer(state, setStreaming({ sessionId: 'sdk-stream', active: false }))

    state = agentChatReducer(state, addAssistantMessage({
      sessionId: 'sdk-stream',
      content: [{ type: 'text', text: 'final reply' }],
    }))

    expect(state.sessions['sdk-stream']).toMatchObject({
      status: 'running',
      streamingActive: false,
      streamingText: '',
    })
    expect(state.sessions['sdk-stream'].messages).toHaveLength(1)
    expect(state.sessions['sdk-stream'].messages[0]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: [{ type: 'text', text: 'final reply' }],
    }))
  })

  it('stores hydrated turn bodies separately from live websocket messages', () => {
    const state = agentChatReducer(initial, turnBodyReceived({
      sessionId: 'sess-turn',
      turn: makeTimelineTurn('turn-7', 'user', 'Hydrated older turn', {
        sessionId: 'sess-turn',
        messageId: 'message-7',
        ordinal: 7,
      }),
    }))

    expect(state.sessions['sess-turn'].messages).toEqual([])
    expect(state.sessions['sess-turn'].timelineBodies['turn-7']).toEqual(
      expect.objectContaining({
        messageId: 'message-7',
        ordinal: 7,
        source: 'durable',
        message: expect.objectContaining({
          content: [{ type: 'text', text: 'Hydrated older turn' }],
        }),
      }),
    )
  })

  it('hydrates inline page bodies and clears stale replace-mode bodies', () => {
    let state = agentChatReducer(initial, turnBodyReceived({
      sessionId: 'sdk-1',
      turn: makeTimelineTurn('stale-turn', 'assistant', 'stale', {
        sessionId: 'cli-1',
      }),
    }))

    state = agentChatReducer(state, timelinePageReceived({
      sessionId: 'sdk-1',
      items: [makeTimelineItem('turn-2', 'assistant', 'hello', {
        sessionId: 'cli-1',
        messageId: 'message-2',
        ordinal: 2,
      })],
      nextCursor: null,
      revision: 12,
      replace: true,
      bodies: {
        'turn-2': makeTimelineTurn('turn-2', 'assistant', 'hello', {
          sessionId: 'cli-1',
          messageId: 'message-2',
          ordinal: 2,
        }),
      },
    }))

    expect(state.sessions['sdk-1'].timelineItems).toEqual([
      expect.objectContaining({
        turnId: 'turn-2',
        messageId: 'message-2',
        ordinal: 2,
        source: 'durable',
      }),
    ])
    expect(state.sessions['sdk-1'].timelineBodies['turn-2']).toEqual(expect.objectContaining({
      turnId: 'turn-2',
      messageId: 'message-2',
      ordinal: 2,
      source: 'durable',
      message: makeChatMessage('assistant', 'hello'),
    }))
    expect(state.sessions['sdk-1'].timelineBodies['stale-turn']).toBeUndefined()
  })

  it('preserves previously expanded bodies when appending an older timeline page', () => {
    let state = agentChatReducer(initial, turnBodyReceived({
      sessionId: 'sdk-1',
      turn: makeTimelineTurn('turn-newest', 'assistant', 'newest full body', {
        sessionId: 'cli-1',
      }),
    }))

    state = agentChatReducer(state, timelinePageReceived({
      sessionId: 'sdk-1',
      items: [makeTimelineItem('turn-older', 'user', 'older question', { sessionId: 'cli-1' })],
      nextCursor: 'cursor-older',
      revision: 13,
      replace: false,
      bodies: {
        'turn-older': makeTimelineTurn('turn-older', 'user', 'older full body', { sessionId: 'cli-1' }),
      },
    }))

    expect(state.sessions['sdk-1'].timelineBodies).toEqual(expect.objectContaining({
      'turn-newest': makeTimelineTurn('turn-newest', 'assistant', 'newest full body', { sessionId: 'cli-1' }),
      'turn-older': makeTimelineTurn('turn-older', 'user', 'older full body', { sessionId: 'cli-1' }),
    }))
  })

  it('bootstraps session on timelinePageReceived for unknown sessionId', () => {
    const state = agentChatReducer(initial, timelinePageReceived({
      sessionId: 'unknown-sess',
      items: [
        makeTimelineItem('turn-1', 'user', 'hello', {
          sessionId: 'unknown-sess',
          ordinal: 1,
          timestamp: '2026-01-01T00:00:00Z',
        }),
      ],
      nextCursor: null,
      revision: 1,
      replace: true,
    }))
    expect(state.sessions['unknown-sess']).toBeDefined()
    expect(state.sessions['unknown-sess'].timelineItems).toHaveLength(1)
    expect(state.sessions['unknown-sess'].historyLoaded).toBe(true)
  })

  it('bootstraps session on setSessionStatus for unknown sessionId', () => {
    const state = agentChatReducer(initial, setSessionStatus({
      sessionId: 'unknown-sess',
      status: 'idle',
    }))
    expect(state.sessions['unknown-sess']).toBeDefined()
    expect(state.sessions['unknown-sess'].status).toBe('idle')
  })

  it('bootstraps session on sessionInit for unknown sessionId', () => {
    const state = agentChatReducer(initial, sessionInit({
      sessionId: 'unknown-sess',
      cliSessionId: 'cli-123',
      model: 'claude-opus-4-6',
    }))
    expect(state.sessions['unknown-sess']).toBeDefined()
    expect(state.sessions['unknown-sess'].cliSessionId).toBe('cli-123')
    expect(state.sessions['unknown-sess'].status).toBe('connected')
  })

  it('sets lastError on sessionError', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = agentChatReducer(state, sessionError({ sessionId: 's1', message: 'CLI crashed' }))
    expect(state.sessions['s1'].lastError).toBe('CLI crashed')
  })

  it('clears a pendingCreates entry', () => {
    let state = agentChatReducer(initial, registerPendingCreate({
      requestId: 'req-1',
      expectsHistoryHydration: true,
    }))
    state = agentChatReducer(state, sessionCreated({ requestId: 'req-1', sessionId: 's1' }))
    expect(state.pendingCreates['req-1']).toEqual({
      sessionId: 's1',
      expectsHistoryHydration: true,
    })
    state = agentChatReducer(state, clearPendingCreate({ requestId: 'req-1' }))
    expect(state.pendingCreates['req-1']).toBeUndefined()
  })

  it('removes a session', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = agentChatReducer(state, removeSession({ sessionId: 's1' }))
    expect(state.sessions['s1']).toBeUndefined()
  })

  it('setAvailableModels populates models', () => {
    const models = [
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Most capable' },
      { value: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet 4.5', description: 'Fast' },
    ]
    const state = agentChatReducer(initial, setAvailableModels({ models }))
    expect(state.availableModels).toEqual(models)
    expect(state.availableModels).toHaveLength(2)
  })

  it('accumulates cost when costUsd is 0', () => {
    let state = agentChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = agentChatReducer(state, turnResult({
      sessionId: 's1',
      costUsd: 0.05,
      usage: { input_tokens: 100, output_tokens: 50 },
    }))
    state = agentChatReducer(state, turnResult({
      sessionId: 's1',
      costUsd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    }))
    // costUsd 0 should still be accumulated (no-op, but not skipped)
    expect(state.sessions['s1'].totalCostUsd).toBe(0.05)
    expect(state.sessions['s1'].totalInputTokens).toBe(100)
  })
})
