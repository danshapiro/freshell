// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { TerminalViewMirror } from '../../../../server/terminal-view/mirror.js'

describe('TerminalViewMirror', () => {
  it('serializes the visible viewport deterministically and tracks tailSeq', () => {
    const mirror = new TerminalViewMirror({
      terminalId: 'term-1',
      cols: 80,
      rows: 2,
      runtime: {
        title: 'Shell',
        status: 'running',
        cwd: '/tmp/project',
        pid: 4242,
      },
    })

    mirror.applyOutput('first line\r\n')
    mirror.applyOutput('\u001B[31msecond line\u001B[0m\r\nthird line')

    expect(mirror.getViewportSnapshot()).toEqual({
      terminalId: 'term-1',
      revision: 3,
      serialized: 'second line\nthird line',
      cols: 80,
      rows: 2,
      tailSeq: 2,
      runtime: {
        title: 'Shell',
        status: 'running',
        cwd: '/tmp/project',
        pid: 4242,
      },
    })
  })

  it('updates runtime metadata without disturbing the serialized viewport', () => {
    const mirror = new TerminalViewMirror({
      terminalId: 'term-2',
      cols: 120,
      rows: 3,
      runtime: {
        title: 'Detached shell',
        status: 'detached',
        cwd: '/worktree',
      },
    })

    mirror.applyOutput('alpha\nbeta\ngamma')
    mirror.setRuntime({
      title: 'Exited shell',
      status: 'exited',
      cwd: '/worktree',
      pid: 9001,
    })

    expect(mirror.getViewportSnapshot()).toEqual({
      terminalId: 'term-2',
      revision: 3,
      serialized: 'alpha\nbeta\ngamma',
      cols: 120,
      rows: 3,
      tailSeq: 1,
      runtime: {
        title: 'Exited shell',
        status: 'exited',
        cwd: '/worktree',
        pid: 9001,
      },
    })
  })
})
