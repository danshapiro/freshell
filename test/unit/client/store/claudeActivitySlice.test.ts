import { describe, expect, it } from 'vitest'
import claudeActivityReducer, {
  removeClaudeActivity,
  resetClaudeActivity,
  setClaudeActivitySnapshot,
  upsertClaudeActivity,
} from '@/store/claudeActivitySlice'

describe('claudeActivitySlice', () => {
  it('replaces state from claude.activity.list.response snapshot payloads', () => {
    const first = claudeActivityReducer(
      undefined,
      setClaudeActivitySnapshot({
        terminals: [
          {
            terminalId: 'term-1',
            sessionId: 'session-1',
            phase: 'busy',
            updatedAt: 100,
          },
        ],
      }),
    )

    const second = claudeActivityReducer(
      first,
      setClaudeActivitySnapshot({
        terminals: [
          {
            terminalId: 'term-2',
            sessionId: 'session-2',
            phase: 'busy',
            updatedAt: 200,
          },
        ],
        requestSeq: 2,
      }),
    )

    expect(Object.keys(second.byTerminalId)).toEqual(['term-2'])
    expect(second.byTerminalId['term-2']?.phase).toBe('busy')
  })

  it('ignores older snapshots that arrive after a newer snapshot already applied', () => {
    const newest = claudeActivityReducer(
      undefined,
      setClaudeActivitySnapshot({
        terminals: [
          {
            terminalId: 'term-1',
            sessionId: 'session-1',
            phase: 'idle',
            updatedAt: 200,
          },
        ],
        requestSeq: 2,
      }),
    )

    const stale = claudeActivityReducer(
      newest,
      setClaudeActivitySnapshot({
        terminals: [
          {
            terminalId: 'term-1',
            sessionId: 'session-1',
            phase: 'busy',
            updatedAt: 100,
          },
        ],
        requestSeq: 1,
      }),
    )

    expect(stale.byTerminalId['term-1']?.phase).toBe('idle')
  })

  it('preserves newer live upserts when an older snapshot arrives', () => {
    const stateWithUpsert = claudeActivityReducer(
      undefined,
      upsertClaudeActivity({
        terminals: [
          {
            terminalId: 'term-1',
            sessionId: 'session-1',
            phase: 'busy',
            updatedAt: 500,
          },
        ],
        mutationSeq: 2,
      }),
    )

    const next = claudeActivityReducer(
      stateWithUpsert,
      setClaudeActivitySnapshot({
        terminals: [],
        requestSeq: 1,
      }),
    )

    expect(next.byTerminalId['term-1']?.phase).toBe('busy')
  })

  it('ratchets upserts by updatedAt', () => {
    const initial = claudeActivityReducer(
      undefined,
      upsertClaudeActivity({
        terminals: [
          {
            terminalId: 'term-1',
            sessionId: 'session-1',
            phase: 'busy',
            updatedAt: 500,
          },
        ],
        mutationSeq: 1,
      }),
    )

    const next = claudeActivityReducer(
      initial,
      upsertClaudeActivity({
        terminals: [
          {
            terminalId: 'term-1',
            sessionId: 'session-1',
            phase: 'idle',
            updatedAt: 400,
          },
          {
            terminalId: 'term-2',
            sessionId: 'session-2',
            phase: 'busy',
            updatedAt: 600,
          },
        ],
        mutationSeq: 2,
      }),
    )

    expect(next.byTerminalId['term-1']?.phase).toBe('busy')
    expect(next.byTerminalId['term-2']?.phase).toBe('busy')
  })

  it('keeps removals authoritative even when snapshot and record timestamps are older on the client clock', () => {
    const initial = claudeActivityReducer(
      undefined,
      upsertClaudeActivity({
        terminals: [
          {
            terminalId: 'term-1',
            sessionId: 'session-1',
            phase: 'busy',
            updatedAt: 1_000,
          },
        ],
        mutationSeq: 10,
      }),
    )

    const removed = claudeActivityReducer(
      initial,
      removeClaudeActivity({
        terminalIds: ['term-1'],
        mutationSeq: 11,
      }),
    )

    const next = claudeActivityReducer(
      removed,
      setClaudeActivitySnapshot({
        terminals: [
          {
            terminalId: 'term-1',
            sessionId: 'session-1',
            phase: 'busy',
            updatedAt: 900,
          },
        ],
        requestSeq: 9,
      }),
    )

    expect(next.byTerminalId['term-1']).toBeUndefined()
  })

  it('resets stale overlay records and sequencing state', () => {
    const populated = claudeActivityReducer(
      undefined,
      upsertClaudeActivity({
        terminals: [
          {
            terminalId: 'term-1',
            sessionId: 'session-1',
            phase: 'busy',
            updatedAt: 1_000,
          },
        ],
        mutationSeq: 7,
      }),
    )

    const removed = claudeActivityReducer(
      populated,
      removeClaudeActivity({
        terminalIds: ['term-2'],
        mutationSeq: 8,
      }),
    )

    const reset = claudeActivityReducer(removed, resetClaudeActivity())

    expect(reset).toEqual({
      byTerminalId: {},
      lastSnapshotSeq: 0,
      liveMutationSeqByTerminalId: {},
      removedMutationSeqByTerminalId: {},
    })
  })
})
