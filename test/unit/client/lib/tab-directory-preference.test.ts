import { describe, it, expect } from 'vitest'
import { getTabDirectoryPreference, rankCandidateDirectories } from '@/lib/tab-directory-preference'
import type { PaneNode } from '@/store/paneTypes'

// Helper to create a terminal leaf
function terminalLeaf(id: string, initialCwd?: string): PaneNode {
  return {
    type: 'leaf',
    id,
    content: {
      kind: 'terminal',
      mode: 'claude',
      shell: 'system',
      createRequestId: `cr-${id}`,
      status: 'running',
      initialCwd,
    },
  }
}

// Helper to create an agent-chat leaf
function chatLeaf(id: string, initialCwd?: string): PaneNode {
  return {
    type: 'leaf',
    id,
    content: {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: `cr-${id}`,
      status: 'connected',
      initialCwd,
    },
  }
}

// Helper to create a picker leaf
function pickerLeaf(id: string): PaneNode {
  return { type: 'leaf', id, content: { kind: 'picker' } }
}

// Helper to create a browser leaf
function browserLeaf(id: string): PaneNode {
  return { type: 'leaf', id, content: { kind: 'browser', url: '', devToolsOpen: false } }
}

function split(left: PaneNode, right: PaneNode): PaneNode {
  return {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    children: [left, right],
    sizes: [50, 50],
  }
}

describe('getTabDirectoryPreference', () => {
  it('returns undefined default and empty list for a single picker pane', () => {
    const result = getTabDirectoryPreference(pickerLeaf('p1'))
    expect(result).toEqual({ defaultCwd: undefined, tabDirectories: [] })
  })

  it('returns the only directory when one terminal pane exists', () => {
    const node = split(
      terminalLeaf('t1', '/home/user/code/freshell'),
      pickerLeaf('p1'),
    )
    const result = getTabDirectoryPreference(node)
    expect(result.defaultCwd).toBe('/home/user/code/freshell')
    expect(result.tabDirectories).toEqual(['/home/user/code/freshell'])
  })

  it('picks the most-used directory as default', () => {
    const node: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      children: [
        split(
          terminalLeaf('t1', '/code/alpha'),
          terminalLeaf('t2', '/code/beta'),
        ),
        split(
          terminalLeaf('t3', '/code/alpha'),
          pickerLeaf('p1'),
        ),
      ],
      sizes: [50, 50],
    }
    const result = getTabDirectoryPreference(node)
    expect(result.defaultCwd).toBe('/code/alpha')
    expect(result.tabDirectories).toEqual(['/code/alpha', '/code/beta'])
  })

  it('uses alphabetical tiebreaker when directories have equal frequency', () => {
    const node = split(
      terminalLeaf('t1', '/code/beta'),
      terminalLeaf('t2', '/code/alpha'),
    )
    const result = getTabDirectoryPreference(node)
    expect(result.defaultCwd).toBe('/code/alpha')
    expect(result.tabDirectories).toEqual(['/code/alpha', '/code/beta'])
  })

  it('includes agent-chat pane directories', () => {
    const node = split(
      chatLeaf('c1', '/code/project'),
      terminalLeaf('t1', '/code/project'),
    )
    const result = getTabDirectoryPreference(node)
    expect(result.defaultCwd).toBe('/code/project')
    expect(result.tabDirectories).toEqual(['/code/project'])
  })

  it('ignores panes without initialCwd', () => {
    const node = split(
      terminalLeaf('t1', undefined),
      terminalLeaf('t2', '/code/alpha'),
    )
    const result = getTabDirectoryPreference(node)
    expect(result.defaultCwd).toBe('/code/alpha')
    expect(result.tabDirectories).toEqual(['/code/alpha'])
  })

  it('ignores browser and editor panes', () => {
    const node = split(
      browserLeaf('b1'),
      terminalLeaf('t1', '/code/alpha'),
    )
    const result = getTabDirectoryPreference(node)
    expect(result.defaultCwd).toBe('/code/alpha')
    expect(result.tabDirectories).toEqual(['/code/alpha'])
  })

  it('returns undefined default and empty list when no panes have directories', () => {
    const node = split(
      terminalLeaf('t1', undefined),
      browserLeaf('b1'),
    )
    const result = getTabDirectoryPreference(node)
    expect(result).toEqual({ defaultCwd: undefined, tabDirectories: [] })
  })
})

describe('rankCandidateDirectories', () => {
  it('boosts tab directories and global default above other candidates', () => {
    const candidates = ['/code/gamma', '/code/alpha', '/code/beta', '/code/delta']
    const tabDirectories = ['/code/alpha', '/code/beta']
    const globalDefault = '/code/gamma'

    const result = rankCandidateDirectories(candidates, tabDirectories, globalDefault)

    // Tab dirs first (in tab frequency order), then global default, then rest
    expect(result).toEqual([
      '/code/alpha',
      '/code/beta',
      '/code/gamma',
      '/code/delta',
    ])
  })

  it('deduplicates when global default is also a tab directory', () => {
    const candidates = ['/code/alpha', '/code/beta', '/code/gamma']
    const tabDirectories = ['/code/alpha']
    const globalDefault = '/code/alpha'

    const result = rankCandidateDirectories(candidates, tabDirectories, globalDefault)

    expect(result).toEqual(['/code/alpha', '/code/beta', '/code/gamma'])
  })

  it('preserves original order for non-boosted candidates', () => {
    const candidates = ['/z/last', '/a/first', '/m/middle']
    const tabDirectories: string[] = []
    const globalDefault = undefined

    const result = rankCandidateDirectories(candidates, tabDirectories, globalDefault)

    expect(result).toEqual(['/z/last', '/a/first', '/m/middle'])
  })

  it('includes global default even if not in candidate list', () => {
    const candidates = ['/code/alpha']
    const tabDirectories: string[] = []
    const globalDefault = '/code/beta'

    const result = rankCandidateDirectories(candidates, tabDirectories, globalDefault)

    expect(result).toEqual(['/code/beta', '/code/alpha'])
  })

  it('includes tab directories even if not in candidate list', () => {
    const candidates = ['/code/gamma']
    const tabDirectories = ['/code/alpha']
    const globalDefault = undefined

    const result = rankCandidateDirectories(candidates, tabDirectories, globalDefault)

    expect(result).toEqual(['/code/alpha', '/code/gamma'])
  })

  it('handles empty candidates gracefully', () => {
    const result = rankCandidateDirectories([], ['/code/alpha'], '/code/beta')
    expect(result).toEqual(['/code/alpha', '/code/beta'])
  })

  it('handles everything empty', () => {
    const result = rankCandidateDirectories([], [], undefined)
    expect(result).toEqual([])
  })
})
