import { describe, expect, it, vi } from 'vitest'
import { reconcileTerminalSessionAssociation } from '@/lib/terminal-session-association'

function createState(content: Record<string, unknown>) {
  return {
    panes: {
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content,
        },
      },
    },
    tabs: {
      tabs: [{
        id: 'tab-1',
        title: 'Tab 1',
        status: 'running',
      }],
    },
  } as any
}

describe('terminal-session-association', () => {
  it('returns conflict and refuses to overwrite an existing canonical sessionRef', () => {
    const dispatch = vi.fn()
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState: () => createState({
        kind: 'terminal',
        terminalId: 'term-1',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'codex',
        shell: 'system',
        sessionRef: { provider: 'codex', sessionId: 'thread-new' },
      }),
      terminalId: 'term-1',
      sessionRef: { provider: 'codex', sessionId: 'thread-old' },
    })

    expect(result).toBe('conflict')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reconciles matching canonical identity and clears legacy resumeSessionId', () => {
    const dispatch = vi.fn()
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState: () => createState({
        kind: 'terminal',
        terminalId: 'term-1',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'codex',
        shell: 'system',
        resumeSessionId: 'legacy-thread',
        sessionRef: { provider: 'codex', sessionId: 'thread-1' },
        codexDurability: {
          schemaVersion: 1,
          state: 'durable',
          durableThreadId: 'thread-1',
        },
      }),
      terminalId: 'term-1',
      sessionRef: { provider: 'codex', sessionId: 'thread-1' },
    })

    expect(result).toBe('reconciled')
    expect(dispatch).toHaveBeenCalled()
  })

  it('ignores unmatched panes cleanly', () => {
    const dispatch = vi.fn()
    const result = reconcileTerminalSessionAssociation({
      dispatch,
      getState: () => createState({
        kind: 'terminal',
        terminalId: 'term-2',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'codex',
        shell: 'system',
      }),
      terminalId: 'term-1',
      sessionRef: { provider: 'codex', sessionId: 'thread-1' },
    })

    expect(result).toBe('ignored')
    expect(dispatch).not.toHaveBeenCalled()
  })
})
