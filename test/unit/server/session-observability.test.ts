import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setSessionLifecycleLoggerForTest,
  recordSessionLifecycleEvent,
} from '../../../server/session-observability'

describe('session observability', () => {
  const info = vi.fn()
  const warn = vi.fn()

  beforeEach(() => {
    info.mockReset()
    warn.mockReset()
    __setSessionLifecycleLoggerForTest({ info, warn })
  })

  it('records normal lifecycle events at info with a stable event envelope', () => {
    recordSessionLifecycleEvent({
      kind: 'session_association_broadcast',
      provider: 'codex',
      terminalId: 'term-1',
      sessionId: 'thread-1',
      source: 'indexer_update',
    })

    expect(info).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
    expect(info.mock.calls[0][0]).toMatchObject({
      event: 'session_lifecycle',
      kind: 'session_association_broadcast',
      provider: 'codex',
      terminalId: 'term-1',
      sessionId: 'thread-1',
      source: 'indexer_update',
    })
    expect(info.mock.calls[0][1]).toBe('session_association_broadcast')
  })

  it('records incident events at warn and never logs terminal input data', () => {
    recordSessionLifecycleEvent({
      kind: 'invalid_terminal_id_without_session_ref',
      provider: 'codex',
      terminalId: 'term-stale',
      connectionId: 'conn-1',
      operation: 'terminal.input',
      tabId: 'tab-1',
      paneId: 'pane-1',
      attemptedInputBytes: 120,
      input: 'terminal input should never be logged',
      env: { AUTH_TOKEN: 'secret-token' },
      args: ['--token', 'secret-token'],
    } as any)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(info).not.toHaveBeenCalled()
    const payload = warn.mock.calls[0][0]
    expect(payload).toMatchObject({
      event: 'session_lifecycle',
      kind: 'invalid_terminal_id_without_session_ref',
      terminalId: 'term-stale',
      operation: 'terminal.input',
      attemptedInputBytes: 120,
    })
    expect(JSON.stringify(payload)).not.toContain('terminal input')
    expect(JSON.stringify(payload)).not.toContain('AUTH_TOKEN')
    expect(JSON.stringify(payload)).not.toContain('secret-token')
  })
})
