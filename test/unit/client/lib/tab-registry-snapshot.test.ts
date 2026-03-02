import { describe, expect, it } from 'vitest'
import { shouldKeepClosedTab, collectPaneSnapshots } from '@/lib/tab-registry-snapshot'
import type { PaneNode } from '@/store/paneTypes'

describe('shouldKeepClosedTab', () => {
  it('keeps when open for more than 5 minutes', () => {
    expect(shouldKeepClosedTab({
      openDurationMs: 6 * 60_000,
      paneCount: 1,
      titleSetByUser: false,
    })).toBe(true)
  })

  it('keeps when pane count is greater than one', () => {
    expect(shouldKeepClosedTab({
      openDurationMs: 60_000,
      paneCount: 2,
      titleSetByUser: false,
    })).toBe(true)
  })

  it('keeps when title was set by user', () => {
    expect(shouldKeepClosedTab({
      openDurationMs: 60_000,
      paneCount: 1,
      titleSetByUser: true,
    })).toBe(true)
  })

  it('does not keep otherwise', () => {
    expect(shouldKeepClosedTab({
      openDurationMs: 60_000,
      paneCount: 1,
      titleSetByUser: false,
    })).toBe(false)
  })
})

describe('collectPaneSnapshots', () => {
  describe('extension content', () => {
    it('serializes extension pane content with correct kind and payload', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: {
          kind: 'extension',
          extensionName: 'my-ext',
          props: { key: 'val' },
        },
      }

      const snapshots = collectPaneSnapshots(node, 'server-1')

      expect(snapshots).toEqual([{
        paneId: 'pane-1',
        kind: 'extension',
        title: undefined,
        payload: {
          extensionName: 'my-ext',
          props: { key: 'val' },
        },
      }])
    })

    it('preserves extension data in a split tree', () => {
      const node: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          {
            type: 'leaf',
            id: 'pane-left',
            content: {
              kind: 'extension',
              extensionName: 'ext-a',
              props: { count: 42 },
            },
          },
          {
            type: 'leaf',
            id: 'pane-right',
            content: {
              kind: 'extension',
              extensionName: 'ext-b',
              props: { nested: { deep: true } },
            },
          },
        ],
      }

      const snapshots = collectPaneSnapshots(node, 'server-2')

      expect(snapshots).toHaveLength(2)
      expect(snapshots[0]).toEqual({
        paneId: 'pane-left',
        kind: 'extension',
        title: undefined,
        payload: {
          extensionName: 'ext-a',
          props: { count: 42 },
        },
      })
      expect(snapshots[1]).toEqual({
        paneId: 'pane-right',
        kind: 'extension',
        title: undefined,
        payload: {
          extensionName: 'ext-b',
          props: { nested: { deep: true } },
        },
      })
    })

    it('includes pane title when provided', () => {
      const node: PaneNode = {
        type: 'leaf',
        id: 'pane-titled',
        content: {
          kind: 'extension',
          extensionName: 'my-ext',
          props: {},
        },
      }

      const snapshots = collectPaneSnapshots(node, 'server-1', {
        'pane-titled': 'My Extension Pane',
      })

      expect(snapshots[0].title).toBe('My Extension Pane')
    })
  })
})
