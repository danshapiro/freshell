import { describe, expect, it } from 'vitest'

import panesReducer, { initLayout } from '@/store/panesSlice'
import type { PaneNode } from '@/store/paneTypes'

describe('FreshAgent checkpoint outcomes', () => {
  it('keeps bounded settled outcomes and drops transient or unrecognized fields', () => {
    const state = panesReducer(undefined, initLayout({
      tabId: 'tab-checkpoints',
      paneId: 'pane-checkpoints',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'create-1',
        status: 'running',
        checkpointOutcomes: [
          {
            requestId: 'send-available',
            conversationRequestId: 'create-1',
            displayTurnId: 'turn-4:row-0',
            nativeTurnId: 'native-user-4',
            status: 'available',
            checkpointId: 'checkpoint-4',
            workspace: { path: '/work/project', provenance: 'directory-picker' },
            outgoingText: 'must never be retained',
          },
          {
            requestId: 'send-unavailable',
            conversationRequestId: 'create-1',
            displayTurnId: 'turn-5:row-0',
            status: 'unavailable',
            code: 'checkpoint_path_unreadable',
            reason: 'A selected file could not be read.\nRetry after fixing permissions.',
            outgoingText: 'must never be retained',
          },
          {
            requestId: 'send-pending',
            status: 'pending',
          },
          {
            requestId: 'bad identity with spaces',
            status: 'unavailable',
            reason: 'invalid identity',
          },
          {
            version: 2,
            requestId: 'unsupported-version',
            status: 'unavailable',
            reason: 'must not be interpreted as version 1',
          },
          {
            requestId: 'stale-conversation-outcome',
            conversationRequestId: 'create-replaced',
            status: 'unavailable',
            code: 'capture_failed',
            reason: 'belongs to the previous conversation',
          },
        ],
      } as never,
    }))

    const leaf = state.layouts['tab-checkpoints'] as Extract<PaneNode, { type: 'leaf' }>
    expect(leaf.content).toMatchObject({
      kind: 'fresh-agent',
      checkpointOutcomes: [
        {
          version: 1,
          requestId: 'send-available',
          conversationRequestId: 'create-1',
          displayTurnId: 'turn-4:row-0',
          nativeTurnId: 'native-user-4',
          status: 'available',
          checkpointId: 'checkpoint-4',
          workspace: { path: '/work/project', provenance: 'directory-picker' },
        },
        {
          version: 1,
          requestId: 'send-unavailable',
          conversationRequestId: 'create-1',
          displayTurnId: 'turn-5:row-0',
          status: 'unavailable',
          code: 'checkpoint_path_unreadable',
          reason: 'A selected file could not be read. Retry after fixing permissions.',
        },
      ],
    })
    expect(JSON.stringify(leaf.content)).not.toContain('must never be retained')
  })

  it('keeps only the newest 200 settled outcomes and deduplicates by request id', () => {
    const outcomes = Array.from({ length: 202 }, (_, index) => ({
      requestId: `send-${index}`,
      displayTurnId: `turn-${index}`,
      status: 'unavailable',
      code: 'capture_failed',
      reason: `failure ${index}`,
    }))
    outcomes[201] = {
      requestId: 'send-201',
      displayTurnId: 'turn-201',
      status: 'available',
      checkpointId: 'checkpoint-latest',
      workspace: { path: '/work/project', provenance: 'resolved-project' },
    } as typeof outcomes[number]
    outcomes.push({
      requestId: 'send-201',
      displayTurnId: 'turn-201',
      status: 'unavailable',
      code: 'late_failure',
      reason: 'later result for the same request',
    })

    const state = panesReducer(undefined, initLayout({
      tabId: 'tab-checkpoints',
      paneId: 'pane-checkpoints',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'create-1',
        status: 'running',
        checkpointOutcomes: outcomes,
      } as never,
    }))
    const leaf = state.layouts['tab-checkpoints'] as Extract<PaneNode, { type: 'leaf' }>
    const stored = (leaf.content as { checkpointOutcomes?: Array<Record<string, unknown>> }).checkpointOutcomes!

    expect(stored).toHaveLength(200)
    expect(stored[0].requestId).toBe('send-2')
    expect(stored.at(-1)).toMatchObject({
      requestId: 'send-201',
      status: 'unavailable',
      code: 'late_failure',
    })
  })

  it('retains outcomes from an earlier pane create when the durable session is the same', () => {
    const sessionKey = JSON.stringify(['codex', 'freshcodex', 'thread-reopened-checkpoints'])
    const state = panesReducer(undefined, initLayout({
      tabId: 'tab-checkpoints',
      paneId: 'pane-checkpoints',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        sessionId: 'thread-reopened-checkpoints',
        sessionRef: { provider: 'codex', sessionId: 'thread-reopened-checkpoints' },
        createRequestId: 'new-pane-create',
        status: 'idle',
        checkpointOutcomes: [
          {
            requestId: 'saved-turn',
            conversationRequestId: 'old-pane-create',
            conversationSessionKey: sessionKey,
            displayTurnId: 'thread-reopened-checkpoints:row-0',
            nativeTurnId: 'thread-reopened-checkpoints',
            status: 'available',
            checkpointId: 'saved-checkpoint',
          },
          {
            requestId: 'other-session-turn',
            conversationRequestId: 'old-pane-create',
            conversationSessionKey: JSON.stringify(['codex', 'freshcodex', 'different-thread']),
            displayTurnId: 'different-thread:row-0',
            status: 'available',
            checkpointId: 'other-session-checkpoint',
          },
        ],
      } as never,
    }))

    const leaf = state.layouts['tab-checkpoints'] as Extract<PaneNode, { type: 'leaf' }>
    expect(leaf.content).toMatchObject({
      kind: 'fresh-agent',
      checkpointOutcomes: [{
        requestId: 'saved-turn',
        conversationRequestId: 'old-pane-create',
        conversationSessionKey: sessionKey,
        checkpointId: 'saved-checkpoint',
      }],
    })
  })
})
