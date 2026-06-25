import { describe, expect, it } from 'vitest'

import { CodexThreadItemTypeSchema } from '../../../../server/coding-cli/codex-app-server/protocol.js'
import {
  CodexDisplayConfigError,
  createCodexDisplayId,
  normalizeCodexDisplayTurns,
  normalizeCodexThreadSnapshot,
  normalizeCodexTurn,
  normalizeCodexTurnBody,
  parseCodexDisplayIdHandle,
} from '../../../../server/fresh-agent/adapters/codex/normalize.js'

const DISPLAY_SECRET = 'task-2-deterministic-secret'
const THREAD_ID = 'thread-codex-1'

function normalizeDisplayTurns(
  rawTurn: Record<string, unknown>,
  overrides: {
    model?: string
    secret?: string
    threadId?: string
    submittedRequestIdByProviderTurnId?: Map<string, string | number>
  } = {},
) {
  return normalizeCodexDisplayTurns(rawTurn, 0, {
    model: 'gpt-5.4-mini',
    secret: DISPLAY_SECRET,
    threadId: THREAD_ID,
    ...overrides,
  })
}

describe('Codex fresh-agent normalization', () => {
  it('normalizes codex fork, review, worktree, and child-thread metadata into the shared snapshot', () => {
    const snapshot = normalizeCodexThreadSnapshot({
      threadId: 'thread-codex-1',
      revision: 7,
      status: 'idle',
      transcript: {
        turns: [
          {
            id: 'turn-1',
            turnId: 'turn-1',
            messageId: 'msg-1',
            ordinal: 0,
            source: 'durable',
            role: 'assistant',
            summary: 'Codex finished a review pass',
            items: [{ id: 'turn-1:item-0', kind: 'text', text: 'Codex finished a review pass.' }],
          },
        ],
      },
      rawSnapshot: {
        summary: 'Codex finished a review pass',
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 6,
          cachedTokens: 2,
          totalTokens: 18,
          contextTokens: 18,
          compactPercent: 4,
        },
        worktrees: [{ id: 'wt-1', path: '/repo/.worktrees/task-1', branch: 'feature/task-1' }],
        diffs: [{ id: 'diff-1', path: 'src/app.ts', title: 'src/app.ts' }],
        childThreads: [{ id: 'child-1', threadId: 'thread-child-1', origin: 'subagent', title: 'Review shell' }],
        extension: {
          codex: {
            review: { id: 'review-1', status: 'pending' },
            fork: { parentThreadId: 'thread-parent-1' },
          },
        },
      },
    })

    expect(snapshot.capabilities.send).toBe(true)
    expect(snapshot.capabilities.interrupt).toBe(false)
    expect(snapshot.capabilities.fork).toBe(true)
    expect(snapshot.worktrees[0]?.path).toContain('.worktrees')
    expect(snapshot.childThreads[0]?.origin).toBe('subagent')
    expect(snapshot.extensions.codex).toMatchObject({
      review: { id: 'review-1', status: 'pending' },
      fork: { parentThreadId: 'thread-parent-1' },
    })
    expect(snapshot.diffs[0]).toMatchObject({ path: 'src/app.ts' })
  })

  it('does not promote the first transcript turn into a snapshot summary', () => {
    const snapshot = normalizeCodexThreadSnapshot({
      threadId: 'thread-codex-1',
      revision: 1,
      status: 'idle',
      transcript: {
        turns: [
          {
            id: 'turn-user-1',
            turnId: 'turn-user-1',
            role: 'user',
            summary: 'Do not pin the first user request',
            items: [{ id: 'turn-user-1:item-0', kind: 'text', text: 'Do not pin the first user request' }],
          },
        ],
      },
      rawSnapshot: {},
    })

    expect(snapshot.summary).toBe('')
  })

  it('surfaces the Codex turn model in the shared turn state for single-row turns', () => {
    const turn = normalizeCodexTurn({
      id: 'turn-1',
      model: 'gpt-5.4-mini',
      items: [
        {
          id: 'item-1',
          type: 'agentMessage',
          text: 'Done',
        },
      ],
    }, 0, { threadId: THREAD_ID, secret: DISPLAY_SECRET })

    expect(turn).toMatchObject({
      model: 'gpt-5.4-mini',
      role: 'assistant',
      summary: 'Done',
    })
    expect(turn.turnId).toMatch(/^codex-display:v1:/)
    expect(turn.id).toBe(turn.turnId)
  })

  it('uses the active runtime model as a fallback when Codex omits per-turn model metadata', () => {
    const turn = normalizeCodexTurn({
      id: 'turn-1',
      items: [
        {
          id: 'item-1',
          type: 'agentMessage',
          text: 'Done',
        },
      ],
    }, 0, { threadId: THREAD_ID, model: 'gpt-5.4-mini', secret: DISPLAY_SECRET })

    expect(turn.model).toBe('gpt-5.4-mini')
  })

  it('segments mixed user, reasoning, and agent output into user then assistant display rows', () => {
    const { turns, displayRows } = normalizeDisplayTurns({
      id: 'turn-mixed',
      status: 'completed',
      items: [
        {
          id: 'item-user',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Review the diff.' }],
        },
        {
          id: 'item-reasoning',
          type: 'reasoning',
          summary: ['Comparing changed files'],
          content: ['Walking the patch'],
        },
        {
          id: 'item-agent',
          type: 'agentMessage',
          text: 'I found two regressions.',
        },
      ],
    })

    expect(turns).toHaveLength(2)
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant'])
    expect(turns[0]?.items).toEqual([
      { id: 'item-user:part:0', kind: 'text', text: 'Review the diff.' },
    ])
    expect(turns[1]?.items.map((item) => item.kind)).toEqual(['reasoning', 'text'])
    expect(displayRows.map((row) => row.role)).toEqual(['user', 'assistant'])
  })

  it('uses thread-bound display ids for the same native provider turn id', () => {
    const first = createCodexDisplayId({
      secret: DISPLAY_SECRET,
      threadId: 'thread-alpha',
      providerTurnId: 'turn-shared',
      role: 'assistant',
      itemIds: ['item-agent'],
      partIndexes: [0],
    })
    const second = createCodexDisplayId({
      secret: DISPLAY_SECRET,
      threadId: 'thread-beta',
      providerTurnId: 'turn-shared',
      role: 'assistant',
      itemIds: ['item-agent'],
      partIndexes: [0],
    })

    expect(first).not.toBe(second)
  })

  it('keeps display ids short and opaque to native ids, prompt text, and cursor payloads', () => {
    const turnId = createCodexDisplayId({
      secret: DISPLAY_SECRET,
      threadId: THREAD_ID,
      providerTurnId: 'provider-turn-123',
      role: 'user',
      itemIds: ['provider-item-987'],
      partIndexes: [0],
    })
    const parsed = parseCodexDisplayIdHandle(turnId)
    const decodedHandle = parsed ? Buffer.from(parsed.handle, 'base64url').toString('utf8') : ''

    expect(turnId.length).toBeLessThan(48)
    expect(turnId).not.toContain('provider-turn-123')
    expect(turnId).not.toContain('provider-item-987')
    expect(turnId).not.toContain('printenv SECRET_TOKEN')
    expect(turnId).not.toContain('cursor:opaque-payload')
    expect(decodedHandle).not.toContain('provider-turn-123')
    expect(decodedHandle).not.toContain('provider-item-987')
    expect(decodedHandle).not.toContain('printenv SECRET_TOKEN')
    expect(decodedHandle).not.toContain('cursor:opaque-payload')
  })

  it('fails display normalization when the adapter does not supply a non-empty secret', () => {
    expect(() => normalizeCodexDisplayTurns({
      id: 'turn-missing-secret',
      status: 'completed',
      items: [{
        id: 'item-user',
        type: 'userMessage',
        content: [{ type: 'text', text: 'Prompt' }],
      }],
    }, 0, {
      threadId: THREAD_ID,
      secret: '',
    })).toThrow(CodexDisplayConfigError)

    expect(() => normalizeCodexDisplayTurns({
      id: 'turn-missing-secret',
      status: 'completed',
      items: [{
        id: 'item-user',
        type: 'userMessage',
        content: [{ type: 'text', text: 'Prompt' }],
      }],
    }, 0, {
      threadId: THREAD_ID,
    })).toThrow(/non-empty.*secret/i)
  })

  it('fails display normalization when the adapter does not supply a non-empty threadId', () => {
    expect(() => normalizeCodexDisplayTurns({
      id: 'turn-missing-thread',
      status: 'completed',
      items: [{
        id: 'item-user',
        type: 'userMessage',
        content: [{ type: 'text', text: 'Prompt' }],
      }],
    }, 0, {
      secret: DISPLAY_SECRET,
      threadId: '',
    })).toThrow(CodexDisplayConfigError)

    expect(() => normalizeCodexDisplayTurns({
      id: 'turn-missing-thread',
      status: 'completed',
      items: [{
        id: 'item-user',
        type: 'userMessage',
        content: [{ type: 'text', text: 'Prompt' }],
      }],
    }, 0, {
      secret: DISPLAY_SECRET,
    })).toThrow(/non-empty.*threadId/i)
  })

  it('preserves existing display ids when unrelated rows are inserted later in the provider turn', () => {
    const base = normalizeDisplayTurns({
      id: 'turn-inserted',
      status: 'completed',
      items: [
        {
          id: 'item-user',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Run the tests.' }],
        },
        {
          id: 'item-command',
          type: 'commandExecution',
          command: 'npm test',
          status: 'completed',
          aggregatedOutput: 'ok',
          exitCode: 0,
        },
      ],
    }).turns
    const expanded = normalizeDisplayTurns({
      id: 'turn-inserted',
      status: 'completed',
      items: [
        {
          id: 'item-user',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Run the tests.' }],
        },
        {
          id: 'item-agent',
          type: 'agentMessage',
          text: 'Running them now.',
        },
        {
          id: 'item-command',
          type: 'commandExecution',
          command: 'npm test',
          status: 'completed',
          aggregatedOutput: 'ok',
          exitCode: 0,
        },
      ],
    }).turns

    expect(base.map((turn) => turn.role)).toEqual(['user', 'tool'])
    expect(expanded.map((turn) => turn.role)).toEqual(['user', 'assistant', 'tool'])
    expect(base[0]?.turnId).toBe(expanded[0]?.turnId)
    expect(base[1]?.turnId).toBe(expanded[2]?.turnId)
  })

  it('segments assistant output away from later tool items', () => {
    const { turns } = normalizeDisplayTurns({
      id: 'turn-tools',
      status: 'completed',
      items: [
        {
          id: 'item-agent',
          type: 'agentMessage',
          text: 'Applied the patch.',
        },
        {
          id: 'item-command',
          type: 'commandExecution',
          command: 'npm test',
          status: 'completed',
          aggregatedOutput: 'ok',
          exitCode: 0,
        },
        {
          id: 'item-file-change',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'src/app.ts', changeType: 'modified' }],
        },
      ],
    })

    expect(turns).toHaveLength(2)
    expect(turns.map((turn) => turn.role)).toEqual(['assistant', 'tool'])
    expect(turns[1]?.items.map((item) => item.kind)).toEqual(['command', 'file_change'])
  })

  it('classifies every Codex thread item type into a normalized display role', () => {
    const factories: Record<(typeof CodexThreadItemTypeSchema.options)[number], Record<string, unknown>> = {
      userMessage: { type: 'userMessage', content: [{ type: 'text', text: 'Prompt' }] },
      hookPrompt: { type: 'hookPrompt' },
      agentMessage: { type: 'agentMessage', text: 'Done' },
      plan: { type: 'plan', text: '1. Do the work' },
      reasoning: { type: 'reasoning', summary: ['Thinking'], content: ['Longer trace'] },
      commandExecution: { type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: 'ok', exitCode: 0 },
      fileChange: { type: 'fileChange', status: 'completed', changes: [{ path: 'src/app.ts' }] },
      mcpToolCall: { type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'completed', arguments: { q: 'codex' }, result: { ok: true } },
      dynamicToolCall: { type: 'dynamicToolCall', namespace: 'tools', tool: 'exec', status: 'completed', arguments: { cmd: 'pwd' }, contentItems: [], success: true },
      collabAgentToolCall: { type: 'collabAgentToolCall', tool: 'dispatch', status: 'completed', senderThreadId: 'thread-parent', receiverThreadIds: ['thread-child'], agentsStates: {} },
      webSearch: { type: 'webSearch', query: 'freshell' },
      imageView: { type: 'imageView', path: '/tmp/screenshot.png' },
      imageGeneration: { type: 'imageGeneration', status: 'completed', result: 'saved', revisedPrompt: 'prompt' },
      enteredReviewMode: { type: 'enteredReviewMode', review: 'security' },
      exitedReviewMode: { type: 'exitedReviewMode', review: 'security' },
      contextCompaction: { type: 'contextCompaction' },
    }
    const expectedRoles: Record<(typeof CodexThreadItemTypeSchema.options)[number], string> = {
      userMessage: 'user',
      hookPrompt: 'system',
      agentMessage: 'assistant',
      plan: 'assistant',
      reasoning: 'assistant',
      commandExecution: 'tool',
      fileChange: 'tool',
      mcpToolCall: 'tool',
      dynamicToolCall: 'tool',
      collabAgentToolCall: 'tool',
      webSearch: 'tool',
      imageView: 'tool',
      imageGeneration: 'tool',
      enteredReviewMode: 'system',
      exitedReviewMode: 'system',
      contextCompaction: 'system',
    }

    for (const type of CodexThreadItemTypeSchema.options) {
      const result = normalizeDisplayTurns({
        id: `turn-${type}`,
        status: 'inProgress',
        items: [{ id: `item-${type}`, ...factories[type] }],
      })

      expect(result.turns).toHaveLength(1)
      expect(result.turns[0]?.role).toBe(expectedRoles[type])
    }
  })

  it('extracts user text from content, then input_text, then text, then summary', () => {
    const fromContent = normalizeDisplayTurns({
      id: 'turn-content',
      status: 'completed',
      items: [{
        id: 'item-user',
        type: 'userMessage',
        text: 'fallback text',
        summary: 'fallback summary',
        content: [{ type: 'text', text: 'from content array' }],
      }],
    }).turns[0]
    const fromInputText = normalizeDisplayTurns({
      id: 'turn-input-text',
      status: 'completed',
      items: [{
        id: 'item-user',
        type: 'userMessage',
        content: [{ type: 'input_text', text: 'from input_text part' }],
      }],
    }).turns[0]
    const fromText = normalizeDisplayTurns({
      id: 'turn-text',
      status: 'completed',
      items: [{
        id: 'item-user',
        type: 'userMessage',
        text: 'from top-level text',
      }],
    }).turns[0]
    const fromSummary = normalizeDisplayTurns({
      id: 'turn-summary',
      status: 'completed',
      items: [{
        id: 'item-user',
        type: 'userMessage',
        summary: 'from top-level summary',
      }],
    }).turns[0]

    expect(fromContent?.items[0]).toMatchObject({ kind: 'text', text: 'from content array' })
    expect(fromInputText?.items[0]).toMatchObject({ kind: 'text', text: 'from input_text part' })
    expect(fromText?.items[0]).toMatchObject({ kind: 'text', text: 'from top-level text' })
    expect(fromSummary?.items[0]).toMatchObject({ kind: 'text', text: 'from top-level summary' })
  })

  it('adds an assistant empty-response sentinel after completed user-only turns', () => {
    const turns = normalizeDisplayTurns({
      id: 'turn-empty',
      status: 'completed',
      items: [{
        id: 'item-user',
        type: 'userMessage',
        content: [{ type: 'text', text: 'Write a temp file.' }],
      }],
    }).turns

    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant'])
    expect(turns[1]?.items).toEqual([
      {
        id: 'codex-display-synthetic:empty-response',
        kind: 'text',
        text: 'Codex completed this turn without recording an assistant response.',
      },
    ])
  })

  it('adds an assistant error row after failed user-only turns', () => {
    const turns = normalizeDisplayTurns({
      id: 'turn-error',
      status: 'failed',
      error: { message: 'model rejected the request' },
      items: [{
        id: 'item-user',
        type: 'userMessage',
        content: [{ type: 'text', text: 'Do the thing.' }],
      }],
    }).turns

    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant'])
    expect(turns[1]?.items).toEqual([
      {
        id: 'codex-display-synthetic:error',
        kind: 'text',
        text: 'Codex turn failed: model rejected the request',
      },
    ])
  })

  it('throws a protocol error when a provider item that participates in identity is missing an id', () => {
    expect(() => normalizeDisplayTurns({
      id: 'turn-missing-item-id',
      status: 'completed',
      items: [{
        type: 'userMessage',
        content: [{ type: 'text', text: 'Prompt' }],
      }],
    })).toThrow(/protocol|stable item id/i)
  })

  it('reuses submitted user display ids when the provider userMessage later materializes', () => {
    const requestId = 'request-42'
    const submittedTurnId = createCodexDisplayId({
      secret: DISPLAY_SECRET,
      threadId: THREAD_ID,
      providerTurnId: 'turn-submitted',
      role: 'user',
      syntheticKind: 'submitted-input',
      requestId,
    })
    const turns = normalizeDisplayTurns({
      id: 'turn-submitted',
      status: 'completed',
      items: [{
        id: 'item-user',
        type: 'userMessage',
        content: [{ type: 'text', text: 'Ship it.' }],
      }],
    }, {
      submittedRequestIdByProviderTurnId: new Map([['turn-submitted', requestId]]),
    }).turns

    expect(turns[0]?.turnId).toBe(submittedTurnId)
  })

  it('rejects malformed codex-display prefixes as invalid public ids', () => {
    expect(parseCodexDisplayIdHandle('codex-display:not-a-valid-envelope')).toBeNull()
  })

  it('selects the exact requested display row for turn bodies and throws when it is absent', () => {
    const rawTurn = {
      id: 'turn-body',
      status: 'completed',
      items: [
        {
          id: 'item-user',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Review the diff.' }],
        },
        {
          id: 'item-reasoning',
          type: 'reasoning',
          summary: ['Comparing changed files'],
          content: ['Walking the patch'],
        },
        {
          id: 'item-agent',
          type: 'agentMessage',
          text: 'I found two regressions.',
        },
      ],
    }
    const turns = normalizeDisplayTurns(rawTurn).turns
    const assistantTurnId = turns[1]?.turnId
    expect(assistantTurnId).toBeTruthy()

    const assistantBody = normalizeCodexTurnBody({
      threadId: THREAD_ID,
      revision: 9,
      requestedTurnId: assistantTurnId ?? '',
      rawTurn,
      model: 'gpt-5.4-mini',
      secret: DISPLAY_SECRET,
    })

    expect(assistantBody.turnId).toBe(assistantTurnId)
    expect(assistantBody.role).toBe('assistant')
    expect(assistantBody.items.map((item) => item.kind)).toEqual(['reasoning', 'text'])
    expect(() => normalizeCodexTurnBody({
      threadId: THREAD_ID,
      revision: 9,
      requestedTurnId: 'codex-display:v1:not-found-handle',
      rawTurn,
      model: 'gpt-5.4-mini',
      secret: DISPLAY_SECRET,
    })).toThrow(/not found/i)

    expect(() => normalizeCodexTurnBody({
      threadId: THREAD_ID,
      revision: 9,
      requestedTurnId: '',
      rawTurn,
      model: 'gpt-5.4-mini',
      secret: DISPLAY_SECRET,
    })).toThrow(/not found/i)

    expect(() => normalizeCodexTurnBody({
      threadId: THREAD_ID,
      revision: 9,
      requestedTurnId: undefined as unknown as string,
      rawTurn,
      model: 'gpt-5.4-mini',
      secret: DISPLAY_SECRET,
    })).toThrow(/not found/i)
  })

  it('fails body normalization when the adapter does not supply a non-empty secret', () => {
    const rawTurn = {
      id: 'turn-body-secret',
      status: 'completed',
      items: [{
        id: 'item-user',
        type: 'userMessage',
        content: [{ type: 'text', text: 'Review the diff.' }],
      }],
    }

    expect(() => normalizeCodexTurnBody({
      threadId: THREAD_ID,
      revision: 9,
      requestedTurnId: 'codex-display:v1:missingsecret0000',
      rawTurn,
      model: 'gpt-5.4-mini',
      secret: '',
    })).toThrow(CodexDisplayConfigError)
  })
})
