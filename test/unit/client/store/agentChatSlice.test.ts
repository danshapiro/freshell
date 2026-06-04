import { describe, expect, it } from 'vitest'
import reducer, {
  sessionError,
  setSessionStatus,
  setStreaming,
} from '@/store/agentChatSlice'

describe('agentChatSlice busy/streaming clearing', () => {
  function running() {
    let s = reducer(undefined, setSessionStatus({ sessionId: 'x', status: 'running' }))
    s = reducer(s, setStreaming({ sessionId: 'x', active: true }))
    return s
  }

  it('setSessionStatus(idle) clears streamingActive so the pane does not stay blue', () => {
    let s = running()
    expect(s.sessions['x'].streamingActive).toBe(true)
    s = reducer(s, setSessionStatus({ sessionId: 'x', status: 'idle' }))
    expect(s.sessions['x'].streamingActive).toBe(false)
    expect(s.sessions['x'].status).toBe('idle')
  })

  it('sessionError (non-RESTORE) clears streamingActive and resets running -> idle', () => {
    let s = running()
    s = reducer(s, sessionError({ sessionId: 'x', message: 'boom' }))
    expect(s.sessions['x'].streamingActive).toBe(false)
    expect(s.sessions['x'].status).toBe('idle')
  })

  it('sessionError (RESTORE_*) does NOT reset running/streaming (restore path preserved)', () => {
    let s = running()
    s = reducer(s, sessionError({ sessionId: 'x', message: 'restore failed', code: 'RESTORE_TIMEOUT' }))
    expect(s.sessions['x'].status).toBe('running')
  })
})
