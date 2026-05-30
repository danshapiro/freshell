import { describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_BUSY_DEADMAN_MS,
  ClaudeActivityTracker,
  type ClaudeActivityChange,
  type ClaudeTurnCompleteEvent,
} from '../../../../server/coding-cli/claude-activity-tracker'

function setup() {
  const tracker = new ClaudeActivityTracker()
  const changes: ClaudeActivityChange[] = []
  const completions: ClaudeTurnCompleteEvent[] = []
  tracker.on('changed', (c: ClaudeActivityChange) => changes.push(c))
  tracker.on('turn.complete', (e: ClaudeTurnCompleteEvent) => completions.push(e))
  return { tracker, changes, completions }
}

describe('ClaudeActivityTracker', () => {
  it('starts idle on track and goes busy on submit', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
  })

  it('does not start a turn on multiline paste', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: 'line one\nline two', at: 2000 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
  })

  it('completes a turn on Stop-hook BEL and emits exactly one turn.complete', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteOutput({ terminalId: 't1', data: 'thinking...', at: 2500 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    tracker.noteOutput({ terminalId: 't1', data: '\x07', at: 3000 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ terminalId: 't1', at: 3000 })
  })

  it('ignores a BEL while idle (false-positive guard)', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteOutput({ terminalId: 't1', data: '\x07', at: 2000 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(0)
  })

  it('ignores a stray BEL embedded in visible mid-turn output', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteOutput({ terminalId: 't1', data: 'before\x07after', at: 2500 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)
  })

  it('handles two queued submits with two completions', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2100 })
    tracker.noteOutput({ terminalId: 't1', data: '\x07', at: 3000 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    tracker.noteOutput({ terminalId: 't1', data: '\x07', at: 4000 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(2)
  })

  it('self-heals a stuck-busy terminal after the deadman', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.expire(2000 + CLAUDE_BUSY_DEADMAN_MS + 1)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(0)
  })

  it('output refreshes liveness so the deadman does not fire on an active turn', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteOutput({ terminalId: 't1', data: 'progress', at: 2000 + CLAUDE_BUSY_DEADMAN_MS })
    tracker.expire(2000 + CLAUDE_BUSY_DEADMAN_MS + 1)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
  })

  it('removes state on exit and emits a removal', () => {
    const { tracker, changes } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteExit({ terminalId: 't1' })
    expect(tracker.getActivity('t1')).toBeUndefined()
    expect(changes.at(-1)).toEqual({ upsert: [], remove: ['t1'] })
  })

  it('list() reflects current records', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    expect(tracker.list()).toEqual([{ terminalId: 't1', phase: 'busy', updatedAt: 2000 }])
  })

  it('attaches sessionId via bindSession', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.bindSession({ terminalId: 't1', sessionId: 's-1', at: 1500 })
    expect(tracker.getActivity('t1')?.sessionId).toBe('s-1')
  })
})
