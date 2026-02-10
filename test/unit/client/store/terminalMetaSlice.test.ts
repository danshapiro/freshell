import { describe, it, expect } from 'vitest'
import terminalMetaReducer, {
  setTerminalMetaSnapshot,
  upsertTerminalMeta,
  removeTerminalMeta,
} from '@/store/terminalMetaSlice'

describe('terminalMetaSlice', () => {
  it('replaces state from terminal.meta.list.response snapshot payloads', () => {
    const first = terminalMetaReducer(
      undefined,
      setTerminalMetaSnapshot({
        terminals: [
          {
            terminalId: 'term-1',
            displaySubdir: 'repo-a',
            branch: 'main',
            updatedAt: 100,
          },
        ],
      }),
    )

    const second = terminalMetaReducer(
      first,
      setTerminalMetaSnapshot({
        terminals: [
          {
            terminalId: 'term-2',
            displaySubdir: 'repo-b',
            branch: 'feature',
            updatedAt: 200,
          },
        ],
        requestedAt: 150,
      }),
    )

    expect(Object.keys(second.byTerminalId)).toEqual(['term-2'])
    expect(second.byTerminalId['term-2']?.displaySubdir).toBe('repo-b')
  })

  it('applies upsert patches from terminal.meta.updated', () => {
    const initial = terminalMetaReducer(
      undefined,
      setTerminalMetaSnapshot({
        terminals: [
          {
            terminalId: 'term-1',
            displaySubdir: 'repo-a',
            branch: 'main',
            updatedAt: 100,
          },
        ],
      }),
    )

    const next = terminalMetaReducer(
      initial,
      upsertTerminalMeta([
        {
          terminalId: 'term-1',
          displaySubdir: 'repo-a',
          branch: 'main',
          tokenUsage: {
            inputTokens: 100,
            outputTokens: 50,
            cachedTokens: 10,
            totalTokens: 160,
            compactThresholdTokens: 640,
            compactPercent: 25,
          },
          updatedAt: 150,
        },
        {
          terminalId: 'term-2',
          displaySubdir: 'repo-b',
          branch: 'feature',
          updatedAt: 160,
        },
      ]),
    )

    expect(next.byTerminalId['term-1']?.tokenUsage?.compactPercent).toBe(25)
    expect(next.byTerminalId['term-2']?.displaySubdir).toBe('repo-b')
  })

  it('removes metadata on terminal exit', () => {
    const initial = terminalMetaReducer(
      undefined,
      setTerminalMetaSnapshot({
        terminals: [
          {
            terminalId: 'term-1',
            displaySubdir: 'repo-a',
            branch: 'main',
            updatedAt: 100,
          },
          {
            terminalId: 'term-2',
            displaySubdir: 'repo-b',
            branch: 'feature',
            updatedAt: 200,
          },
        ],
      }),
    )

    const next = terminalMetaReducer(initial, removeTerminalMeta('term-1'))

    expect(next.byTerminalId['term-1']).toBeUndefined()
    expect(next.byTerminalId['term-2']?.displaySubdir).toBe('repo-b')
  })

  it('keeps newer local upserts when an older snapshot response arrives', () => {
    const stateWithUpsert = terminalMetaReducer(
      undefined,
      upsertTerminalMeta([
        {
          terminalId: 'term-1',
          displaySubdir: 'repo-a',
          branch: 'main',
          updatedAt: 500,
        },
      ]),
    )

    const next = terminalMetaReducer(
      stateWithUpsert,
      setTerminalMetaSnapshot({
        terminals: [],
        requestedAt: 400,
      }),
    )

    expect(next.byTerminalId['term-1']?.displaySubdir).toBe('repo-a')
  })

  it('drops stale local entries when snapshot is newer than existing metadata', () => {
    const initial = terminalMetaReducer(
      undefined,
      upsertTerminalMeta([
        {
          terminalId: 'term-1',
          displaySubdir: 'repo-a',
          branch: 'main',
          updatedAt: 500,
        },
      ]),
    )

    const next = terminalMetaReducer(
      initial,
      setTerminalMetaSnapshot({
        terminals: [],
        requestedAt: 600,
      }),
    )

    expect(next.byTerminalId['term-1']).toBeUndefined()
  })
})
