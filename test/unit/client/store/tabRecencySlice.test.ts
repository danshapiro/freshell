import { describe, expect, it } from 'vitest'
import reducer, {
  loadPersistedTabRecency,
  mergeHydratedTabRecency,
  prunePaneTabActivityToLiveTerminalPanes,
  recordPaneTabActivity,
  serializePersistableTabRecency,
} from '@/store/tabRecencySlice'

describe('tabRecencySlice', () => {
  it('stores pane activity at 60-second resolution', () => {
    const state = reducer(undefined, recordPaneTabActivity({
      paneId: 'pane-1',
      at: 1_740_000_059_999,
    }))

    expect(state.paneLastInputAt['pane-1']).toBe(1_740_000_000_000)
  })

  it('does not move a pane backward', () => {
    const first = reducer(undefined, recordPaneTabActivity({
      paneId: 'pane-1',
      at: 1_740_000_120_000,
    }))
    const second = reducer(first, recordPaneTabActivity({
      paneId: 'pane-1',
      at: 1_740_000_060_000,
    }))

    expect(second.paneLastInputAt['pane-1']).toBe(1_740_000_120_000)
  })

  it('records the zero minute bucket for deterministic tests and epoch data', () => {
    const state = reducer(undefined, recordPaneTabActivity({
      paneId: 'pane-1',
      at: 0,
    }))

    expect(state.paneLastInputAt['pane-1']).toBe(0)
  })

  it('ignores invalid pane ids and timestamps', () => {
    const state = reducer(undefined, recordPaneTabActivity({
      paneId: '',
      at: Number.NaN,
    }))

    expect(state.paneLastInputAt).toEqual({})
  })

  it('loads only valid persisted minute buckets', () => {
    expect(loadPersistedTabRecency(JSON.stringify({
      version: 1,
      paneLastInputAt: {
        'pane-1': 1_740_000_000_000,
        'pane-2': 1_740_000_059_999,
        bad: -1,
      },
    }))).toEqual({
      paneLastInputAt: {
        'pane-1': 1_740_000_000_000,
        'pane-2': 1_740_000_000_000,
      },
    })
  })

  it('serializes only minute-bucketed recency values for live terminal panes', () => {
    const state = reducer(undefined, recordPaneTabActivity({
      paneId: 'pane-1',
      at: 1_740_000_059_999,
    }))
    const withStalePane = {
      paneLastInputAt: {
        ...state.paneLastInputAt,
        stale: 1_740_000_000_000,
        'pane-picker': 1_740_000_120_000,
      },
    }

    expect(serializePersistableTabRecency(withStalePane, {
      'tab-1': {
        type: 'split',
        id: 'root',
        direction: 'horizontal',
        children: [
          {
            type: 'leaf',
            id: 'pane-1',
            content: { kind: 'terminal' },
          },
          {
            type: 'leaf',
            id: 'pane-picker',
            content: { kind: 'picker' },
          },
        ],
      } as any,
      'closed-tab': {
        type: 'leaf',
        id: 'stale',
        content: { kind: 'terminal' },
      } as any,
    }, new Set(['tab-1']))).toEqual({
      version: 1,
      paneLastInputAt: {
        'pane-1': 1_740_000_000_000,
      },
    })
  })

  it('merges cross-window recency by per-pane max without dropping local panes', () => {
    const state = reducer({
      paneLastInputAt: {
        'pane-local': 1_740_000_120_000,
        'pane-shared': 1_740_000_120_000,
      },
    }, mergeHydratedTabRecency({
      paneLastInputAt: {
        'pane-remote': 1_740_000_060_000,
        'pane-shared': 1_740_000_000_000,
      },
    }))

    expect(state).toEqual({
      paneLastInputAt: {
        'pane-local': 1_740_000_120_000,
        'pane-remote': 1_740_000_060_000,
        'pane-shared': 1_740_000_120_000,
      },
    })
  })

  it('prunes live state to current terminal pane ids', () => {
    const state = reducer({
      paneLastInputAt: {
        'pane-terminal': 1_740_000_000_000,
        'pane-replaced': 1_740_000_060_000,
      },
    }, prunePaneTabActivityToLiveTerminalPanes({
      paneIds: ['pane-terminal'],
    }))

    expect(state).toEqual({
      paneLastInputAt: {
        'pane-terminal': 1_740_000_000_000,
      },
    })
  })
})
