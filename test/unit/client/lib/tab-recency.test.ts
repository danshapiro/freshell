import { describe, expect, it } from 'vitest'
import {
  TAB_RECENCY_RESOLUTION_MS,
  bucketTabRecencyAt,
  collectTerminalPaneIds,
  deriveTabRecencyAt,
} from '@/lib/tab-recency'

describe('tab recency helpers', () => {
  it('rounds timestamps down to 60-second buckets', () => {
    expect(TAB_RECENCY_RESOLUTION_MS).toBe(60_000)
    expect(bucketTabRecencyAt(1_740_000_059_999)).toBe(1_740_000_000_000)
    expect(bucketTabRecencyAt(1_740_000_060_000)).toBe(1_740_000_060_000)
  })

  it('ignores missing and invalid timestamps', () => {
    expect(bucketTabRecencyAt(undefined)).toBeUndefined()
    expect(bucketTabRecencyAt(null)).toBeUndefined()
    expect(bucketTabRecencyAt(Number.NaN)).toBeUndefined()
    expect(bucketTabRecencyAt(-1)).toBeUndefined()
  })

  it('collects only current terminal pane ids', () => {
    const layout = {
      type: 'split',
      id: 'root',
      direction: 'horizontal',
      children: [
        {
          type: 'leaf',
          id: 'pane-terminal',
          content: { kind: 'terminal' },
        },
        {
          type: 'leaf',
          id: 'pane-picker',
          content: { kind: 'picker' },
        },
      ],
    } as any

    expect(collectTerminalPaneIds(layout)).toEqual(['pane-terminal'])
  })

  it('derives tab recency from latest terminal-pane activity and tab fallback fields', () => {
    const tab = {
      id: 'tab-1',
      createdAt: 1_740_000_000_000,
      lastInputAt: 1_740_000_020_000,
    }
    const layout = {
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
          id: 'pane-2',
          content: { kind: 'terminal' },
        },
      ],
    } as any

    expect(deriveTabRecencyAt({
      tab,
      layout,
      paneLastInputAt: {
        'pane-1': 1_740_000_030_000,
        'pane-2': 1_740_000_080_000,
      },
    })).toBe(1_740_000_060_000)
  })

  it('does not treat tab.updatedAt or non-terminal pane ids as activity recency', () => {
    const tab = {
      id: 'tab-1',
      createdAt: 1_740_000_000_000,
      updatedAt: 1_740_000_180_000,
      lastInputAt: 1_740_000_080_000,
    } as any
    const layout = {
      type: 'leaf',
      id: 'pane-1',
      content: { kind: 'picker' },
    } as any

    expect(deriveTabRecencyAt({
      tab,
      layout,
      paneLastInputAt: {
        'pane-1': 1_740_000_240_000,
      },
    })).toBe(1_740_000_060_000)
  })
})
