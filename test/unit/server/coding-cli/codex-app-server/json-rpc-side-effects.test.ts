import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  extractForkResponseCandidate,
  normalizeThreadForkResponseForTui,
  rewriteThreadForkRequestExcludeTurns,
} from '../../../../../server/coding-cli/codex-app-server/json-rpc-side-effects.js'

function parseRewritten(input: string): Record<string, unknown> {
  const rewritten = rewriteThreadForkRequestExcludeTurns(Buffer.from(input))
  expect(rewritten.ok).toBe(true)
  if (!rewritten.ok) throw new Error(rewritten.reason)
  return JSON.parse(rewritten.raw.toString()) as Record<string, unknown>
}

describe('rewriteThreadForkRequestExcludeTurns', () => {
  it('forces thread/fork params.excludeTurns to true without changing unrelated fields', () => {
    const rewritten = parseRewritten(JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'thread/fork',
      params: {
        threadId: 'thread-parent',
        cwd: '/repo',
        excludeTurns: false,
        nested: { excludeTurns: false },
      },
    }))

    expect(rewritten).toMatchObject({
      jsonrpc: '2.0',
      id: 5,
      method: 'thread/fork',
      params: {
        threadId: 'thread-parent',
        cwd: '/repo',
        excludeTurns: true,
        nested: { excludeTurns: false },
      },
    })
  })

  it('adds params when the fork request omits params', () => {
    expect(parseRewritten('{"id":"fork-1","method":"thread/fork"}')).toEqual({
      id: 'fork-1',
      method: 'thread/fork',
      params: { excludeTurns: true },
    })
  })

  it('rejects root arrays instead of forwarding an uncompacted batched fork', () => {
    expect(rewriteThreadForkRequestExcludeTurns('[{"id":1,"method":"thread/fork","params":{"threadId":"parent"}}]')).toEqual({
      ok: false,
      reason: 'batch_unsupported',
    })
  })

  it('rejects duplicate params or excludeTurns keys as unsafe for mutation', () => {
    expect(rewriteThreadForkRequestExcludeTurns('{"id":1,"method":"thread/fork","params":{"threadId":"parent"},"params":{"excludeTurns":false}}')).toEqual({
      ok: false,
      reason: 'unsafe_duplicate_key',
    })
    expect(rewriteThreadForkRequestExcludeTurns('{"id":1,"method":"thread/fork","params":{"threadId":"parent","excludeTurns":false,"excludeTurns":true}}')).toEqual({
      ok: false,
      reason: 'unsafe_duplicate_key',
    })
  })
})

describe('extractForkResponseCandidate', () => {
  const rolloutPath = path.join(process.cwd(), 'tmp', 'codex-child-rollout.jsonl')
  const pendingForkRequestIds = new Set<string | number>([12, 'fork-2'])

  it('extracts a staged fork candidate only from the matching top-level fork response id', () => {
    const result = extractForkResponseCandidate(JSON.stringify({
      id: 12,
      result: {
        thread: {
          id: 'thread-child',
          path: rolloutPath,
          ephemeral: false,
          turns: [{ id: 'nested-turn', payload: { id: 12 } }],
        },
      },
    }), {
      parentThreadId: 'thread-parent',
      pendingForkRequestIds,
      provenForkPathField: 'path',
    })

    expect(result).toEqual({
      ok: true,
      candidate: {
        source: 'thread_fork_response',
        thread: {
          id: 'thread-child',
          path: rolloutPath,
          ephemeral: false,
        },
      },
    })
  })

  it('rejects fork responses without a deterministic durable path', () => {
    for (const thread of [
      { id: 'thread-child', path: null },
      { id: 'thread-child', path: 'relative/rollout.jsonl' },
      { id: 'thread-child', path: rolloutPath, rolloutPath: `${rolloutPath}.other` },
      { id: 'thread-child', path: rolloutPath, ephemeral: true },
      { id: 'thread-parent', path: rolloutPath },
    ]) {
      expect(extractForkResponseCandidate(JSON.stringify({
        id: 12,
        result: { thread },
      }), {
        parentThreadId: 'thread-parent',
        pendingForkRequestIds,
        provenForkPathField: 'path',
      }).ok).toBe(false)
    }
  })

  it('ignores responses whose top-level id was not a forwarded thread/fork request', () => {
    expect(extractForkResponseCandidate(JSON.stringify({
      id: 99,
      result: {
        thread: {
          id: 'thread-child',
          path: rolloutPath,
        },
      },
    }), {
      parentThreadId: 'thread-parent',
      pendingForkRequestIds,
      provenForkPathField: 'path',
    })).toEqual({ ok: false, reason: 'id_not_pending_fork' })
  })
})

describe('normalizeThreadForkResponseForTui', () => {
  const rolloutPath = path.join(process.cwd(), 'tmp', 'codex-child-rollout.jsonl')

  it('adds an empty thread.turns array when compact upstream fork responses omit turns', () => {
    const rewritten = normalizeThreadForkResponseForTui(JSON.stringify({
      id: 12,
      result: {
        thread: {
          id: 'thread-child',
          path: rolloutPath,
          ephemeral: false,
        },
      },
    }))

    expect(rewritten.ok).toBe(true)
    if (!rewritten.ok) throw new Error(rewritten.reason)
    expect(JSON.parse(rewritten.raw.toString())).toEqual({
      id: 12,
      result: {
        thread: {
          id: 'thread-child',
          path: rolloutPath,
          ephemeral: false,
          turns: [],
        },
      },
    })
  })

  it('preserves an existing turns array and rejects root batches', () => {
    const withTurns = normalizeThreadForkResponseForTui(JSON.stringify({
      id: 12,
      result: {
        thread: {
          id: 'thread-child',
          path: rolloutPath,
          turns: [],
        },
      },
    }))

    expect(withTurns.ok).toBe(true)
    if (!withTurns.ok) throw new Error(withTurns.reason)
    expect(JSON.parse(withTurns.raw.toString()).result.thread.turns).toEqual([])

    expect(normalizeThreadForkResponseForTui('[{"id":12,"result":{"thread":{"id":"thread-child"}}}]')).toEqual({
      ok: false,
      reason: 'batch_unsupported',
    })
  })
})
