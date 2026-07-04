import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  CodexFsChangedNotificationSchema,
  CodexThreadLifecycleNotificationSchema,
  CodexThreadOperationResultSchema,
  CodexThreadStartedNotificationSchema,
  CodexTurnCompletedNotificationSchema,
  CodexTurnStartedNotificationSchema,
} from '../../../../../server/coding-cli/codex-app-server/protocol.js'
import {
  extractForkResponseCandidate,
  extractFsChangedRepairTrigger,
  extractThreadLifecycleEvent,
  extractThreadStartResponseCandidate,
  extractThreadStartedNotificationSideEffects,
  extractTurnNotificationEvent,
  normalizeThreadForkResponseForTui,
  rewriteThreadForkRequestExcludeTurns,
} from '../../../../../server/coding-cli/codex-app-server/json-rpc-side-effects.js'

function parseRewritten(input: Parameters<typeof rewriteThreadForkRequestExcludeTurns>[0]): Record<string, unknown> {
  const rewritten = rewriteThreadForkRequestExcludeTurns(input)
  expect(rewritten.ok).toBe(true)
  if (!rewritten.ok) throw new Error(rewritten.reason)
  return JSON.parse(rewritten.raw.toString()) as Record<string, unknown>
}

function parseNormalized(input: string | Buffer): Record<string, unknown> {
  const rewritten = normalizeThreadForkResponseForTui(input)
  expect(rewritten.ok).toBe(true)
  if (!rewritten.ok) throw new Error(rewritten.reason)
  return JSON.parse(rewritten.raw.toString()) as Record<string, unknown>
}

function slicedArrayBuffer(value: string): ArrayBuffer {
  const buffer = Buffer.from(value)
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!
}

function createThread(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    path: null,
    ephemeral: false,
    turns: [],
    ...overrides,
  }
}

function createOperationResult(thread: Record<string, unknown>): Record<string, unknown> {
  return {
    thread,
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    cwd: '/repo',
    model: 'gpt-5',
    modelProvider: 'openai',
    sandbox: 'danger-full-access',
  }
}

function createHugeTurn(): Record<string, unknown> {
  return {
    id: 'turn-huge',
    items: [
      {
        type: 'agentMessage',
        id: 'item-huge',
        text: 'x'.repeat(256 * 1024),
      },
    ],
    status: 'completed',
  }
}

const rolloutPath = path.join(process.cwd(), 'tmp', 'codex-child-rollout.jsonl')

describe('rewriteThreadForkRequestExcludeTurns', () => {
  it('changes false and null excludeTurns values to true while preserving true', () => {
    expect(parseRewritten('{"id":1,"method":"thread/fork","params":{"threadId":"parent","excludeTurns":false}}')).toMatchObject({
      params: { threadId: 'parent', excludeTurns: true },
    })
    expect(parseRewritten('{"id":1,"method":"thread/fork","params":{"threadId":"parent","excludeTurns":null}}')).toMatchObject({
      params: { threadId: 'parent', excludeTurns: true },
    })
    expect(parseRewritten('{"id":1,"method":"thread/fork","params":{"threadId":"parent","excludeTurns":true}}')).toMatchObject({
      params: { threadId: 'parent', excludeTurns: true },
    })
  })

  it('appends excludeTurns to an existing params object that lacks it', () => {
    expect(parseRewritten('{"id":"fork-1","method":"thread/fork","params":{"threadId":"parent","cwd":"/repo"}}')).toEqual({
      id: 'fork-1',
      method: 'thread/fork',
      params: {
        threadId: 'parent',
        cwd: '/repo',
        excludeTurns: true,
      },
    })
  })

  it('creates params when the fork request omits params', () => {
    expect(parseRewritten('{"id":"fork-1","method":"thread/fork"}')).toEqual({
      id: 'fork-1',
      method: 'thread/fork',
      params: { excludeTurns: true },
    })
  })

  it('preserves unrelated top-level and params fields', () => {
    expect(parseRewritten(JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'thread/fork',
      meta: { forwarded: true },
      params: {
        threadId: 'thread-parent',
        cwd: '/repo',
        excludeTurns: false,
        nested: { excludeTurns: false },
      },
    }))).toEqual({
      jsonrpc: '2.0',
      id: 5,
      method: 'thread/fork',
      meta: { forwarded: true },
      params: {
        threadId: 'thread-parent',
        cwd: '/repo',
        excludeTurns: true,
        nested: { excludeTurns: false },
      },
    })
  })

  it('rewrites large fork requests without full-frame JSON.parse, JSON.stringify, or Buffer.toString', () => {
    const raw = Buffer.from(`{"id":7,"method":"thread/fork","params":{"threadId":"parent","excludeTurns":false,"blob":"${'x'.repeat(512 * 1024)}"},"tail":true}`)
    const parseSpy = vi.spyOn(JSON, 'parse')
    const stringifySpy = vi.spyOn(JSON, 'stringify')
    const toStringSpy = vi.spyOn(Buffer.prototype, 'toString')

    const result = rewriteThreadForkRequestExcludeTurns(raw)
    const parseCalls = parseSpy.mock.calls.length
    const stringifyCalls = stringifySpy.mock.calls.length
    const toStringCalls = toStringSpy.mock.calls.length
    parseSpy.mockRestore()
    stringifySpy.mockRestore()
    toStringSpy.mockRestore()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(parseCalls).toBe(0)
    expect(stringifyCalls).toBe(0)
    expect(toStringCalls).toBe(0)
    expect(JSON.parse(result.raw.toString())).toMatchObject({
      id: 7,
      method: 'thread/fork',
      params: {
        threadId: 'parent',
        excludeTurns: true,
      },
      tail: true,
    })
  })

  it('returns structured failures for malformed frames and non-object params values', () => {
    expect(rewriteThreadForkRequestExcludeTurns('{"id":1')).toEqual({
      ok: false,
      reason: 'malformed_json',
    })
    for (const params of ['null', '[]', '"bad"', '7']) {
      expect(rewriteThreadForkRequestExcludeTurns(`{"id":1,"method":"thread/fork","params":${params}}`)).toEqual({
        ok: false,
        reason: 'unsupported_shape',
      })
    }
  })

  it('returns a structured failure for root arrays and batches', () => {
    expect(rewriteThreadForkRequestExcludeTurns('[{"id":1,"method":"thread/fork","params":{"threadId":"parent"}}]')).toEqual({
      ok: false,
      reason: 'batch_unsupported',
    })
  })

  it('decodes escaped params and excludeTurns keys with bounded JSON.parse semantics', () => {
    expect(parseRewritten('{"id":1,"method":"thread/fork","\\u0070arams":{"threadId":"parent","exclude\\u0054urns":false}}')).toMatchObject({
      params: {
        threadId: 'parent',
        excludeTurns: true,
      },
    })
  })

  it('fails closed for duplicate params or duplicate excludeTurns keys', () => {
    expect(rewriteThreadForkRequestExcludeTurns('{"id":1,"method":"thread/fork","params":{"threadId":"parent"},"params":{"excludeTurns":false}}')).toEqual({
      ok: false,
      reason: 'unsafe_duplicate_key',
    })
    expect(rewriteThreadForkRequestExcludeTurns('{"id":1,"method":"thread/fork","params":{"threadId":"parent","excludeTurns":false,"excludeTurns":true}}')).toEqual({
      ok: false,
      reason: 'unsafe_duplicate_key',
    })
  })

  it('matches object-level JSON.parse rewrite semantics for a deterministic valid corpus', () => {
    const random = seededRandom(0xf04c)
    const paramsKeys = ['"params"', '"\\u0070arams"'] as const
    const excludeKeys = ['"excludeTurns"', '"exclude\\u0054urns"'] as const
    const excludeValues = ['false', 'null', 'true', undefined] as const

    for (let index = 0; index < 96; index += 1) {
      const paramsKey = pick(random, paramsKeys)
      const excludeKey = pick(random, excludeKeys)
      const excludeValue = pick(random, excludeValues)
      const paramsEntries = [
        '"threadId":"parent"',
        '"cwd":"/repo"',
        '"nested":{"excludeTurns":false}',
      ]
      if (excludeValue !== undefined) {
        paramsEntries.splice(Math.floor(random() * paramsEntries.length), 0, `${excludeKey}:${excludeValue}`)
      }
      const topEntries = [
        '"jsonrpc":"2.0"',
        '"id":"fork-corpus"',
        '"method":"thread/fork"',
        `${paramsKey}:{${paramsEntries.join(',')}}`,
        '"tail":{"id":"not-top"}',
      ]
      topEntries.sort(() => random() - 0.5)
      const json = `{${topEntries.join(',')}}`
      const expected = JSON.parse(json) as { params?: Record<string, unknown> }
      expected.params = { ...expected.params, excludeTurns: true }

      const rewritten = rewriteThreadForkRequestExcludeTurns(Buffer.from(json))
      expect(rewritten.ok).toBe(true)
      if (!rewritten.ok) throw new Error(rewritten.reason)
      expect(JSON.parse(rewritten.raw.toString())).toEqual(expected)
    }
  })

  it('accepts Buffer arrays and ArrayBuffer inputs', () => {
    const json = '{"id":1,"method":"thread/fork","params":{"threadId":"parent","excludeTurns":false}}'
    expect(parseRewritten([Buffer.from('{"id":1,"method":"thread/fork",'), Buffer.from('"params":{"threadId":"parent","excludeTurns":false}}')])).toMatchObject({
      params: { excludeTurns: true },
    })
    expect(parseRewritten(slicedArrayBuffer(json))).toMatchObject({
      params: { excludeTurns: true },
    })
  })
})

describe('bounded side-effect extractors', () => {
  it('extracts a thread/start response candidate when result.thread.turns appears before top-level id', () => {
    const raw = JSON.stringify({
      result: createOperationResult(createThread('thread-start', {
        path: rolloutPath,
        turns: [createHugeTurn()],
      })),
      id: 'start-1',
    })
    const expected = CodexThreadOperationResultSchema.parse((JSON.parse(raw) as { result: unknown }).result)

    const extracted = extractThreadStartResponseCandidate(Buffer.from(raw), {
      pendingThreadStartRequestIds: new Set(['start-1']),
    })

    expect(extracted).toEqual({
      ok: true,
      candidate: {
        source: 'thread_start_response',
        thread: {
          id: expected.thread.id,
          path: expected.thread.path,
          ephemeral: expected.thread.ephemeral,
        },
      },
    })
  })

  it('extracts a thread/fork response candidate using result.thread.path even when turns precede top-level id', () => {
    const raw = JSON.stringify({
      result: createOperationResult(createThread('thread-child', {
        path: rolloutPath,
        ephemeral: false,
        turns: [
          {
            ...createHugeTurn(),
            path: '/decoy/from-turns.jsonl',
            parentThreadId: 'thread-parent',
          },
        ],
      })),
      id: 12,
    })
    const expected = CodexThreadOperationResultSchema.parse((JSON.parse(raw) as { result: unknown }).result)

    const result = extractForkResponseCandidate(Buffer.from(raw), {
      parentThreadId: 'thread-parent',
      pendingForkRequestIds: new Set<string | number>([12]),
      provenForkPathField: 'path',
    })

    expect(result).toEqual({
      ok: true,
      candidate: {
        source: 'thread_fork_response',
        thread: {
          id: expected.thread.id,
          path: expected.thread.path,
          ephemeral: expected.thread.ephemeral,
        },
      },
    })
  })

  it('extracts thread/started notification candidate and lifecycle metadata with huge thread.turns', () => {
    const raw = JSON.stringify({
      params: {
        thread: createThread('thread-notified', {
          path: rolloutPath,
          turns: [createHugeTurn()],
        }),
      },
      method: 'thread/started',
    })
    const expected = CodexThreadStartedNotificationSchema.parse(JSON.parse(raw))

    const extracted = extractThreadStartedNotificationSideEffects(Buffer.from(raw))

    expect(extracted).toEqual({
      ok: true,
      candidate: {
        source: 'thread_started_notification',
        thread: {
          id: expected.params.thread.id,
          path: expected.params.thread.path,
          ephemeral: expected.params.thread.ephemeral,
        },
      },
      lifecycle: {
        kind: 'thread_started',
        thread: {
          id: expected.params.thread.id,
          path: expected.params.thread.path,
          ephemeral: expected.params.thread.ephemeral,
        },
      },
    })
  })

  it('extracts turn started and completed metadata when the turn body is huge', () => {
    const startedRaw = JSON.stringify({
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        input: [{ type: 'text', text: 'x'.repeat(256 * 1024), text_elements: [] }],
      },
      method: 'turn/started',
    })
    const completedRaw = JSON.stringify({
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        turn: createHugeTurn(),
        status: 'completed',
      },
      method: 'turn/completed',
    })
    const expectedStarted = CodexTurnStartedNotificationSchema.parse(JSON.parse(startedRaw))
    const expectedCompleted = CodexTurnCompletedNotificationSchema.parse(JSON.parse(completedRaw))

    expect(extractTurnNotificationEvent(Buffer.from(startedRaw))).toEqual({
      ok: true,
      event: {
        kind: 'turn_started',
        threadId: expectedStarted.params.threadId,
        turnId: expectedStarted.params.turnId,
      },
    })
    expect(extractTurnNotificationEvent(Buffer.from(completedRaw))).toEqual({
      ok: true,
      event: {
        kind: 'turn_completed',
        threadId: expectedCompleted.params.threadId,
        turnId: expectedCompleted.params.turnId,
        status: expectedCompleted.params.turn?.status ?? expectedCompleted.params.status,
      },
    })
  })

  it('extracts thread/closed and thread/status/changed lifecycle metadata', () => {
    const closedRaw = JSON.stringify({
      params: { threadId: 'thread-1', nested: { threadId: 'decoy' } },
      method: 'thread/closed',
    })
    const statusRaw = JSON.stringify({
      params: { threadId: 'thread-1', status: { type: 'notLoaded', reason: 'evicted' } },
      method: 'thread/status/changed',
    })
    const expectedClosed = CodexThreadLifecycleNotificationSchema.parse(JSON.parse(closedRaw))
    const expectedStatus = CodexThreadLifecycleNotificationSchema.parse(JSON.parse(statusRaw))

    expect(extractThreadLifecycleEvent(Buffer.from(closedRaw))).toEqual({
      ok: true,
      event: {
        kind: 'thread_closed',
        threadId: expectedClosed.params.threadId,
      },
    })
    expect(extractThreadLifecycleEvent(Buffer.from(statusRaw))).toEqual({
      ok: true,
      event: {
        kind: 'thread_status_changed',
        threadId: expectedStatus.params.threadId,
        status: expectedStatus.params.status,
      },
    })
  })

  it('extracts fs/changed repair triggers and collapses oversized changedPaths to an empty list', () => {
    const boundedRaw = JSON.stringify({
      method: 'fs/changed',
      params: { watchId: 'watch-1', changedPaths: ['/repo/a.ts', '/repo/b.ts'] },
    })
    const oversizedRaw = JSON.stringify({
      params: {
        watchId: 'watch-2',
        changedPaths: Array.from({ length: 4096 }, (_, index) => `/repo/${index}.ts`),
      },
      method: 'fs/changed',
    })
    const expected = CodexFsChangedNotificationSchema.parse(JSON.parse(boundedRaw))

    expect(extractFsChangedRepairTrigger(Buffer.from(boundedRaw))).toEqual({
      ok: true,
      trigger: {
        kind: 'fs_changed',
        watchId: expected.params.watchId,
        changedPaths: expected.params.changedPaths,
      },
    })
    expect(extractFsChangedRepairTrigger(Buffer.from(oversizedRaw))).toEqual({
      ok: true,
      trigger: {
        kind: 'fs_changed',
        watchId: 'watch-2',
        changedPaths: [],
      },
    })
  })

  it('does not use nested decoy fields over owned paths and fails cleanly on malformed frames', () => {
    const raw = JSON.stringify({
      params: {
        decoy: { threadId: 'wrong-thread', turnId: 'wrong-turn' },
        threadId: 'thread-owned',
        turnId: 'turn-owned',
      },
      method: 'turn/started',
    })

    expect(extractTurnNotificationEvent(Buffer.from(raw))).toEqual({
      ok: true,
      event: {
        kind: 'turn_started',
        threadId: 'thread-owned',
        turnId: 'turn-owned',
      },
    })
    expect(extractTurnNotificationEvent('{"method":"turn/started","params":')).toEqual({
      ok: false,
      reason: 'malformed_json',
    })
  })

  it('extracts large side effects without full-frame JSON.parse or Buffer.toString', () => {
    const raw = Buffer.from(JSON.stringify({
      result: createOperationResult(createThread('thread-start', {
        path: rolloutPath,
        turns: [createHugeTurn()],
      })),
      id: 'start-1',
    }))
    const parseSpy = vi.spyOn(JSON, 'parse')
    const toStringSpy = vi.spyOn(Buffer.prototype, 'toString')

    const result = extractThreadStartResponseCandidate(raw, {
      pendingThreadStartRequestIds: new Set(['start-1']),
    })
    const parseCalls = parseSpy.mock.calls.length
    const toStringCalls = toStringSpy.mock.calls.length
    parseSpy.mockRestore()
    toStringSpy.mockRestore()

    expect(result.ok).toBe(true)
    expect(parseCalls).toBe(0)
    expect(toStringCalls).toBe(0)
  })

  it('rejects unsafe fork response candidates', () => {
    const baseThread = { id: 'thread-child', path: rolloutPath, ephemeral: false }
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...baseThread, path: null }, 'missing_rollout_path'],
      [{ ...baseThread, path: 'relative/rollout.jsonl' }, 'relative_rollout_path'],
      [{ ...baseThread, ephemeral: true }, 'ephemeral_thread'],
      [{ ...baseThread, id: 'thread-parent' }, 'same_as_parent'],
      [{ ...baseThread, rolloutPath: `${rolloutPath}.other` }, 'path_alias_conflict'],
    ]

    for (const [thread, reason] of cases) {
      expect(extractForkResponseCandidate(JSON.stringify({
        id: 12,
        result: createOperationResult(thread),
      }), {
        parentThreadId: 'thread-parent',
        pendingForkRequestIds: new Set<string | number>([12]),
        provenForkPathField: 'path',
      })).toEqual({ ok: false, reason })
    }
  })

  it('rejects root arrays, ambiguous duplicate owned keys, and non-pending top-level ids after large results', () => {
    expect(extractForkResponseCandidate('[{"id":12,"result":{"thread":{"id":"thread-child"}}}]', {
      parentThreadId: 'thread-parent',
      pendingForkRequestIds: new Set<string | number>([12]),
      provenForkPathField: 'path',
    })).toEqual({ ok: false, reason: 'batch_unsupported' })

    expect(extractForkResponseCandidate('{"id":12,"result":{"thread":{"id":"thread-child","path":"/tmp/a.jsonl","path":"/tmp/b.jsonl"}}}', {
      parentThreadId: 'thread-parent',
      pendingForkRequestIds: new Set<string | number>([12]),
      provenForkPathField: 'path',
    })).toEqual({ ok: false, reason: 'unsafe_duplicate_key' })

    const raw = JSON.stringify({
      result: createOperationResult(createThread('thread-child', {
        path: rolloutPath,
        turns: [
          {
            ...createHugeTurn(),
            requestId: 12,
            path: '/tmp/decoy.jsonl',
          },
        ],
      })),
      id: 'not-pending',
    })
    expect(extractForkResponseCandidate(Buffer.from(raw), {
      parentThreadId: 'thread-parent',
      pendingForkRequestIds: new Set<string | number>([12]),
      provenForkPathField: 'path',
    })).toEqual({ ok: false, reason: 'id_not_pending_fork' })
  })

  it('uses remembered parent attribution for fork responses and refuses missing parent ids', () => {
    const pendingForkRequests = new Map<string | number, { parentThreadId?: string }>([
      [12, { parentThreadId: 'thread-parent' }],
      [13, {}],
    ])
    const raw = JSON.stringify({
      id: 12,
      result: createOperationResult({ id: 'thread-parent', path: rolloutPath }),
    })

    expect(extractForkResponseCandidate(raw, {
      parentThreadId: pendingForkRequests.get(12)?.parentThreadId,
      pendingForkRequestIds: new Set(pendingForkRequests.keys()),
      provenForkPathField: 'path',
    })).toEqual({ ok: false, reason: 'same_as_parent' })

    expect(extractForkResponseCandidate(JSON.stringify({
      id: 13,
      result: createOperationResult({ id: 'thread-child', path: rolloutPath }),
    }), {
      parentThreadId: pendingForkRequests.get(13)?.parentThreadId,
      pendingForkRequestIds: new Set(pendingForkRequests.keys()),
      provenForkPathField: 'path',
    })).toEqual({ ok: false, reason: 'missing_parent_thread_id' })
  })
})

describe('normalizeThreadForkResponseForTui', () => {
  it('adds result.thread.turns when upstream omitted it from a compact fork response', () => {
    expect(parseNormalized(JSON.stringify({
      id: 12,
      result: createOperationResult(createThread('thread-child', {
        path: rolloutPath,
      })),
    }))).toMatchObject({
      id: 12,
      result: {
        thread: {
          id: 'thread-child',
          path: rolloutPath,
          turns: [],
        },
      },
    })
  })

  it('preserves an existing bounded turns array plus unrelated response fields and thread metadata', () => {
    expect(parseNormalized(JSON.stringify({
      jsonrpc: '2.0',
      id: 12,
      result: createOperationResult(createThread('thread-child', {
        path: rolloutPath,
        ephemeral: false,
        preview: 'hello',
        turns: [{ id: 'turn-1', items: [], status: 'completed' }],
      })),
      extra: { keep: true },
    }))).toEqual({
      jsonrpc: '2.0',
      id: 12,
      result: {
        ...createOperationResult(createThread('thread-child', {
          path: rolloutPath,
          ephemeral: false,
          preview: 'hello',
          turns: [{ id: 'turn-1', items: [], status: 'completed' }],
        })),
      },
      extra: { keep: true },
    })
  })

  it('rejects root arrays and duplicate owned keys', () => {
    expect(normalizeThreadForkResponseForTui('[{"id":12,"result":{"thread":{"id":"thread-child"}}}]')).toEqual({
      ok: false,
      reason: 'batch_unsupported',
    })
    expect(normalizeThreadForkResponseForTui('{"id":12,"result":{"thread":{"id":"thread-child","turns":[],"turns":[]}}}')).toEqual({
      ok: false,
      reason: 'unsafe_duplicate_key',
    })
  })
})
