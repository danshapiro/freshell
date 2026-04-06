import { describe, expect, it } from 'vitest'
import opencodeActivityReducer, {
  removeOpencodeActivity,
  resetOpencodeActivity,
  setOpencodeActivitySnapshot,
  upsertOpencodeActivity,
} from '@/store/opencodeActivitySlice'

describe('opencodeActivitySlice', () => {
  it('replaces state from opencode.activity.list.response snapshot payloads', () => {
    const first = opencodeActivityReducer(
      undefined,
      setOpencodeActivitySnapshot({
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

    const second = opencodeActivityReducer(
      first,
      setOpencodeActivitySnapshot({
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
    const newest = opencodeActivityReducer(
      undefined,
      setOpencodeActivitySnapshot({
        terminals: [
          {
            terminalId: 'term-1',
            sessionId: 'session-1',
            phase: 'busy',
            updatedAt: 200,
          },
        ],
        requestSeq: 2,
      }),
    )

    const stale = opencodeActivityReducer(
      newest,
      setOpencodeActivitySnapshot({
        terminals: [],
        requestSeq: 1,
      }),
    )

    expect(stale.byTerminalId['term-1']?.phase).toBe('busy')
  })

  it('preserves newer live upserts when an older snapshot arrives', () => {
    const stateWithUpsert = opencodeActivityReducer(
      undefined,
      upsertOpencodeActivity({
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

    const next = opencodeActivityReducer(
      stateWithUpsert,
      setOpencodeActivitySnapshot({
        terminals: [],
        requestSeq: 1,
      }),
    )

    expect(next.byTerminalId['term-1']?.phase).toBe('busy')
  })

  it('ratchets upserts by updatedAt', () => {
    const initial = opencodeActivityReducer(
      undefined,
      upsertOpencodeActivity({
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

    const next = opencodeActivityReducer(
      initial,
      upsertOpencodeActivity({
        terminals: [
          {
            terminalId: 'term-1',
            sessionId: 'session-1',
            phase: 'busy',
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

    expect(next.byTerminalId['term-1']?.updatedAt).toBe(500)
    expect(next.byTerminalId['term-2']?.phase).toBe('busy')
  })

  it('keeps removals authoritative even when snapshot and record timestamps are older on the client clock', () => {
    const initial = opencodeActivityReducer(
      undefined,
      upsertOpencodeActivity({
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

    const removed = opencodeActivityReducer(
      initial,
      removeOpencodeActivity({
        terminalIds: ['term-1'],
        mutationSeq: 11,
      }),
    )

    const next = opencodeActivityReducer(
      removed,
      setOpencodeActivitySnapshot({
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
    const populated = opencodeActivityReducer(
      undefined,
      upsertOpencodeActivity({
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

    const removed = opencodeActivityReducer(
      populated,
      removeOpencodeActivity({
        terminalIds: ['term-2'],
        mutationSeq: 8,
      }),
    )

    const reset = opencodeActivityReducer(removed, resetOpencodeActivity())

    expect(reset).toEqual({
      byTerminalId: {},
      lastSnapshotSeq: 0,
      liveMutationSeqByTerminalId: {},
      removedMutationSeqByTerminalId: {},
    })
  })
})
