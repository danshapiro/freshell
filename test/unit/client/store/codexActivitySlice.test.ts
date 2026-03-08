import { describe, expect, it } from 'vitest'
import codexActivityReducer, {
  removeCodexActivity,
  resetCodexActivity,
  setCodexActivitySnapshot,
  upsertCodexActivity,
} from '@/store/codexActivitySlice'

describe('codexActivitySlice', () => {
  it('replaces state from codex.activity.list.response snapshot payloads', () => {
    const first = codexActivityReducer(
      undefined,
      setCodexActivitySnapshot({
        terminals: [
          {
            terminalId: 'term-1',
            sessionId: 'session-1',
            phase: 'pending',
            updatedAt: 100,
          },
        ],
      }),
    )

    const second = codexActivityReducer(
      first,
      setCodexActivitySnapshot({
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
    const newest = codexActivityReducer(
      undefined,
      setCodexActivitySnapshot({
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

    const stale = codexActivityReducer(
      newest,
      setCodexActivitySnapshot({
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
    const stateWithUpsert = codexActivityReducer(
      undefined,
      upsertCodexActivity({
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

    const next = codexActivityReducer(
      stateWithUpsert,
      setCodexActivitySnapshot({
        terminals: [],
        requestSeq: 1,
      }),
    )

    expect(next.byTerminalId['term-1']?.phase).toBe('busy')
  })

  it('ratchets upserts by updatedAt', () => {
    const initial = codexActivityReducer(
      undefined,
      upsertCodexActivity({
        terminals: [
          {
            terminalId: 'term-1',
            sessionId: 'session-1',
            phase: 'pending',
            updatedAt: 500,
          },
        ],
        mutationSeq: 1,
      }),
    )

    const next = codexActivityReducer(
      initial,
      upsertCodexActivity({
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

    expect(next.byTerminalId['term-1']?.phase).toBe('pending')
    expect(next.byTerminalId['term-2']?.phase).toBe('busy')
  })

  it('keeps removals authoritative even when snapshot and record timestamps are older on the client clock', () => {
    const initial = codexActivityReducer(
      undefined,
      upsertCodexActivity({
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

    const removed = codexActivityReducer(
      initial,
      removeCodexActivity({
        terminalIds: ['term-1'],
        mutationSeq: 11,
      }),
    )

    const next = codexActivityReducer(
      removed,
      setCodexActivitySnapshot({
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
    const populated = codexActivityReducer(
      undefined,
      upsertCodexActivity({
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

    const removed = codexActivityReducer(
      populated,
      removeCodexActivity({
        terminalIds: ['term-2'],
        mutationSeq: 8,
      }),
    )

    const reset = codexActivityReducer(removed, resetCodexActivity())

    expect(reset).toEqual({
      byTerminalId: {},
      lastSnapshotSeq: 0,
      liveMutationSeqByTerminalId: {},
      removedMutationSeqByTerminalId: {},
    })
  })
})
