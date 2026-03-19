import { describe, it, expect } from 'vitest'
import {
  buildPaneRefreshTarget,
  collectPaneContents,
  findFirstPickerPane,
  paneRefreshTargetMatchesContent,
} from '@/lib/pane-utils'
import type { PaneNode, PaneContent } from '@/store/paneTypes'

function leaf(id: string, content: PaneContent): PaneNode {
  return { type: 'leaf', id, content }
}

function split(children: [PaneNode, PaneNode]): PaneNode {
  return { type: 'split', id: 'split-1', direction: 'horizontal', children, sizes: [50, 50] }
}

const shellContent: PaneContent = {
  kind: 'terminal', mode: 'shell', shell: 'system', createRequestId: 'r1', status: 'running',
}
const claudeContent: PaneContent = {
  kind: 'terminal', mode: 'claude', shell: 'system', createRequestId: 'r2', status: 'running',
}
const browserContent: PaneContent = {
  kind: 'browser', browserInstanceId: 'browser-1', url: 'https://example.com', devToolsOpen: false,
}

describe('collectPaneContents', () => {
  it('returns content array from a single leaf', () => {
    const result = collectPaneContents(leaf('p1', shellContent))
    expect(result).toEqual([shellContent])
  })

  it('returns contents from both children of a split', () => {
    const result = collectPaneContents(split([
      leaf('p1', shellContent),
      leaf('p2', claudeContent),
    ]))
    expect(result).toEqual([shellContent, claudeContent])
  })

  it('traverses nested splits depth-first', () => {
    const nested = split([
      split([leaf('p1', shellContent), leaf('p2', claudeContent)]),
      leaf('p3', browserContent),
    ])
    const result = collectPaneContents(nested)
    expect(result).toEqual([shellContent, claudeContent, browserContent])
  })
})

describe('buildPaneRefreshTarget', () => {
  it('returns null for terminal panes without terminalId', () => {
    expect(buildPaneRefreshTarget({
      kind: 'terminal',
      mode: 'shell',
      createRequestId: 'req-1',
      status: 'running',
    })).toBeNull()
  })

  it('returns a terminal target for attached terminals', () => {
    expect(buildPaneRefreshTarget({
      kind: 'terminal',
      mode: 'shell',
      createRequestId: 'req-1',
      terminalId: 'term-1',
      status: 'running',
    })).toEqual({ kind: 'terminal', createRequestId: 'req-1' })
  })

  it('returns null for blank browser panes', () => {
    expect(buildPaneRefreshTarget({
      kind: 'browser',
      browserInstanceId: 'browser-1',
      url: '',
      devToolsOpen: false,
    })).toBeNull()
  })

  it('returns a browser target keyed by browserInstanceId', () => {
    expect(buildPaneRefreshTarget({
      kind: 'browser',
      browserInstanceId: 'browser-1',
      url: 'https://example.test/a',
      devToolsOpen: false,
    })).toEqual({ kind: 'browser', browserInstanceId: 'browser-1' })
  })

  it('returns null instead of throwing for malformed browser content', () => {
    expect(() => buildPaneRefreshTarget({
      kind: 'browser',
      browserInstanceId: 'browser-1',
      url: undefined as any,
      devToolsOpen: false,
    } as any)).not.toThrow()

    expect(buildPaneRefreshTarget({
      kind: 'browser',
      browserInstanceId: 'browser-1',
      url: undefined as any,
      devToolsOpen: false,
    } as any)).toBeNull()
  })
})

describe('paneRefreshTargetMatchesContent', () => {
  it('keeps matching the same browser instance even when url changes', () => {
    expect(
      paneRefreshTargetMatchesContent(
        { kind: 'browser', browserInstanceId: 'browser-1' },
        {
          kind: 'browser',
          browserInstanceId: 'browser-1',
          url: 'https://example.test/b',
          devToolsOpen: false,
        },
      ),
    ).toBe(true)
  })

  it('does not match a different browser instance even when the url is the same', () => {
    expect(
      paneRefreshTargetMatchesContent(
        { kind: 'browser', browserInstanceId: 'browser-1' },
        {
          kind: 'browser',
          browserInstanceId: 'browser-2',
          url: 'https://example.test/a',
          devToolsOpen: false,
        },
      ),
    ).toBe(false)
  })

  it('returns false instead of throwing for malformed browser content', () => {
    expect(() => paneRefreshTargetMatchesContent(
      { kind: 'browser', browserInstanceId: 'browser-1' },
      {
        kind: 'browser',
        browserInstanceId: 'browser-1',
        url: undefined as any,
        devToolsOpen: false,
      } as any,
    )).not.toThrow()

    expect(
      paneRefreshTargetMatchesContent(
        { kind: 'browser', browserInstanceId: 'browser-1' },
        {
          kind: 'browser',
          browserInstanceId: 'browser-1',
          url: undefined as any,
          devToolsOpen: false,
        } as any,
      ),
    ).toBe(false)
  })
})

describe('findFirstPickerPane', () => {
  it('returns undefined for a single non-picker leaf', () => {
    const node: PaneNode = {
      type: 'leaf',
      id: 'pane-1',
      content: { kind: 'terminal', mode: 'shell', createRequestId: 'r1', status: 'running' },
    }
    expect(findFirstPickerPane(node)).toBeUndefined()
  })

  it('returns the id for a single picker leaf', () => {
    const node: PaneNode = {
      type: 'leaf',
      id: 'pane-picker',
      content: { kind: 'picker' },
    }
    expect(findFirstPickerPane(node)).toBe('pane-picker')
  })

  it('returns the left picker in a horizontal split with two pickers', () => {
    const node: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        { type: 'leaf', id: 'left', content: { kind: 'picker' } },
        { type: 'leaf', id: 'right', content: { kind: 'picker' } },
      ],
    }
    expect(findFirstPickerPane(node)).toBe('left')
  })

  it('finds a picker in the right subtree when left has none', () => {
    const node: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        { type: 'leaf', id: 'left', content: { kind: 'terminal', mode: 'shell', createRequestId: 'r1', status: 'running' } },
        { type: 'leaf', id: 'right', content: { kind: 'picker' } },
      ],
    }
    expect(findFirstPickerPane(node)).toBe('right')
  })

  it('returns undefined for a split with no picker panes', () => {
    const node: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        { type: 'leaf', id: 'left', content: { kind: 'terminal', mode: 'shell', createRequestId: 'r1', status: 'running' } },
        { type: 'leaf', id: 'right', content: { kind: 'terminal', mode: 'claude', createRequestId: 'r2', status: 'running' } },
      ],
    }
    expect(findFirstPickerPane(node)).toBeUndefined()
  })

  it('finds picker in deeply nested left subtree', () => {
    const node: PaneNode = {
      type: 'split',
      id: 'split-outer',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        {
          type: 'split',
          id: 'split-inner',
          direction: 'vertical',
          sizes: [50, 50],
          children: [
            { type: 'leaf', id: 'top-left', content: { kind: 'terminal', mode: 'shell', createRequestId: 'r1', status: 'running' } },
            { type: 'leaf', id: 'bottom-left', content: { kind: 'picker' } },
          ],
        },
        { type: 'leaf', id: 'right', content: { kind: 'terminal', mode: 'shell', createRequestId: 'r2', status: 'running' } },
      ],
    }
    expect(findFirstPickerPane(node)).toBe('bottom-left')
  })
})
