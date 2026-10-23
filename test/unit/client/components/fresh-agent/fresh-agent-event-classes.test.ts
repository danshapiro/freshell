import { describe, expect, it } from 'vitest'
import {
  classifyHiddenPaneEvent,
  isSnapshotInvalidatingFreshAgentEvent,
  type HiddenPaneEventClass,
} from '@/components/fresh-agent/fresh-agent-event-classes'

function frame(event: Record<string, unknown>): Record<string, unknown> {
  return { type: 'freshAgent.event', sessionId: 's-1', sessionType: 'freshclaude', provider: 'claude', event }
}

describe('classifyHiddenPaneEvent', () => {
  const cases: Array<[string, Record<string, unknown>, HiddenPaneEventClass]> = [
    // Transcript: the durable conversation may have changed.
    ['session.changed', { type: 'freshAgent.session.changed' }, 'transcript'],
    ['result', { type: 'freshAgent.result' }, 'transcript'],
    ['turn.complete', { type: 'freshAgent.turn.complete' }, 'transcript'],
    ['error', { type: 'freshAgent.error' }, 'transcript'],
    ['assistant', { type: 'freshAgent.assistant' }, 'transcript'],
    ['stream', { type: 'freshAgent.stream' }, 'transcript'],
    ['session.rolledBack', { type: 'freshAgent.session.rolledBack' }, 'transcript'],
    ['session.redone', { type: 'freshAgent.session.redone' }, 'transcript'],
    ['rolledBack ack', { type: 'freshAgent.rolledBack' }, 'transcript'],
    ['redone ack', { type: 'freshAgent.redone' }, 'transcript'],
    ['busy snapshot', { type: 'freshAgent.session.snapshot', status: 'running' }, 'transcript'],
    ['compacting snapshot', { type: 'freshAgent.session.snapshot', status: 'compacting' }, 'transcript'],
    // Surface: only the approval/question cards change.
    ['permission.request', { type: 'freshAgent.permission.request' }, 'surface'],
    ['permission.cancelled', { type: 'freshAgent.permission.cancelled' }, 'surface'],
    ['question.request', { type: 'freshAgent.question.request' }, 'surface'],
    ['question.cancelled', { type: 'freshAgent.question.cancelled' }, 'surface'],
    // None: status-only frames never stale a hidden pane.
    ['idle snapshot', { type: 'freshAgent.session.snapshot', status: 'idle' }, 'none'],
    ['status', { type: 'freshAgent.status', status: 'running' }, 'none'],
    ['session.metadata', { type: 'freshAgent.session.metadata' }, 'none'],
    ['turn.waiting', { type: 'freshAgent.turn.waiting' }, 'none'],
    ['missing type', {}, 'none'],
  ]

  it.each(cases)('classifies %s', (_label, event, expected) => {
    expect(classifyHiddenPaneEvent(frame(event), { busySnapshotSettled: false })).toBe(expected)
  })

  it('classifies a busy-settled idle snapshot as a transcript change', () => {
    expect(classifyHiddenPaneEvent(
      frame({ type: 'freshAgent.session.snapshot', status: 'idle' }),
      { busySnapshotSettled: true },
    )).toBe('transcript')
  })

  it('ignores frames that are not fresh-agent events', () => {
    expect(classifyHiddenPaneEvent(
      { type: 'freshAgent.created', event: { type: 'freshAgent.permission.request' } },
      { busySnapshotSettled: false },
    )).toBe('none')
  })
})

describe('isSnapshotInvalidatingFreshAgentEvent', () => {
  it.each([
    'freshAgent.session.changed',
    'freshAgent.session.snapshot',
    'freshAgent.result',
    'freshAgent.turn.complete',
    'freshAgent.permission.request',
    'freshAgent.permission.cancelled',
    'freshAgent.question.request',
    'freshAgent.question.cancelled',
    'freshAgent.session.rolledBack',
    'freshAgent.session.redone',
    'freshAgent.rolledBack',
    'freshAgent.redone',
  ])('re-drives the snapshot for %s', (type) => {
    expect(isSnapshotInvalidatingFreshAgentEvent(frame({ type }))).toBe(true)
  })

  it.each(['freshAgent.status', 'freshAgent.stream', 'freshAgent.session.metadata'])(
    'does not re-drive the snapshot for %s',
    (type) => {
      expect(isSnapshotInvalidatingFreshAgentEvent(frame({ type }))).toBe(false)
    },
  )
})
