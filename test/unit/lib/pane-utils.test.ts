import { describe, it, expect } from 'vitest'
import { getFirstTerminalCwd } from '../../../src/lib/pane-utils'
import type { PaneNode } from '../../../src/store/paneTypes'

describe('getFirstTerminalCwd', () => {
  it('returns null for editor-only layout', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'p1',
      content: {
        kind: 'editor',
        filePath: null,
        language: null,
        readOnly: false,
        content: '',
        viewMode: 'source',
      },
    }
    expect(getFirstTerminalCwd(layout, {})).toBeNull()
  })

  it('returns cwd from single terminal pane', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'p1',
      content: {
        kind: 'terminal',
        terminalId: 't1',
        createRequestId: 'r1',
        status: 'running',
        mode: 'shell',
      },
    }
    const cwdMap = { t1: '/home/user/project' }
    expect(getFirstTerminalCwd(layout, cwdMap)).toBe('/home/user/project')
  })

  it('returns first terminal cwd in split (depth-first)', () => {
    const layout: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        {
          type: 'leaf',
          id: 'p1',
          content: {
            kind: 'editor',
            filePath: null,
            language: null,
            readOnly: false,
            content: '',
            viewMode: 'source',
          },
        },
        {
          type: 'leaf',
          id: 'p2',
          content: {
            kind: 'terminal',
            terminalId: 't1',
            createRequestId: 'r1',
            status: 'running',
            mode: 'shell',
          },
        },
      ],
    }
    const cwdMap = { t1: '/home/user/project' }
    expect(getFirstTerminalCwd(layout, cwdMap)).toBe('/home/user/project')
  })
})
