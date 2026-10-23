import { describe, expect, it } from 'vitest'
import {
  FreshAgentStreamBatcher,
  LIVE_STREAM_FLUSH_MS,
  type StreamBatcherScheduler,
} from '@/lib/fresh-agent-stream-batcher'
import type { LiveStreamOp } from '@/store/freshAgentLiveTypes'

type Scheduled = { fn: () => void; ms: number; cancelled: boolean }

function manualScheduler() {
  const scheduled: Scheduled[] = []
  const scheduler: StreamBatcherScheduler = {
    set(fn, ms) {
      const entry = { fn, ms, cancelled: false }
      scheduled.push(entry)
      return entry
    },
    clear(handle) {
      (handle as Scheduled).cancelled = true
    },
  }
  const fire = () => {
    const due = scheduled.splice(0).filter((entry) => !entry.cancelled)
    for (const entry of due) entry.fn()
  }
  return { scheduler, scheduled, fire }
}

const claude = { sessionId: 's-1', sessionType: 'freshclaude' as const, provider: 'claude' as const }
const kilroy = { sessionId: 's-2', sessionType: 'kilroy' as const, provider: 'claude' as const }

const delta = (text: string): LiveStreamOp => ({ op: 'delta', messageId: 'msg_1', index: 0, text })

describe('FreshAgentStreamBatcher', () => {
  it('holds stream ops until the flush interval, then applies each session\'s ops in one action, in order', () => {
    const actions: Array<{ type: string; payload: any }> = []
    const { scheduler, scheduled, fire } = manualScheduler()
    const batcher = new FreshAgentStreamBatcher((action) => { actions.push(action as never) }, scheduler)

    batcher.enqueue(claude, { op: 'start', messageId: 'msg_1', index: 0, kind: 'text' })
    batcher.enqueue(claude, delta('Hel'))
    batcher.enqueue(kilroy, delta('other'))
    batcher.enqueue(claude, delta('lo'))

    expect(actions).toEqual([])
    // One timer for the whole burst, at the flush interval.
    expect(scheduled.map((entry) => entry.ms)).toEqual([LIVE_STREAM_FLUSH_MS])

    fire()

    expect(actions.map((action) => action.type)).toEqual(['freshAgentLive/streamOpsApplied', 'freshAgentLive/streamOpsApplied'])
    expect(actions[0].payload).toEqual({
      ...claude,
      ops: [
        { op: 'start', messageId: 'msg_1', index: 0, kind: 'text' },
        delta('Hel'),
        delta('lo'),
      ],
    })
    expect(actions[1].payload).toEqual({ ...kilroy, ops: [delta('other')] })
  })

  it('flushes one session on demand and keeps the others waiting for the timer', () => {
    const actions: Array<{ type: string; payload: any }> = []
    const { scheduler, fire } = manualScheduler()
    const batcher = new FreshAgentStreamBatcher((action) => { actions.push(action as never) }, scheduler)

    batcher.enqueue(claude, delta('a'))
    batcher.enqueue(kilroy, delta('b'))
    batcher.flush(claude)

    expect(actions).toEqual([{ type: 'freshAgentLive/streamOpsApplied', payload: { ...claude, ops: [delta('a')] } }])

    fire()
    expect(actions.map((action) => action.payload.sessionId)).toEqual(['s-1', 's-2'])
    // Nothing left: a later timer would dispatch nothing.
    batcher.flush()
    expect(actions).toHaveLength(2)
  })

  it('dispatches nothing for a session with no pending ops and re-arms the timer after a flush', () => {
    const actions: unknown[] = []
    const { scheduler, scheduled, fire } = manualScheduler()
    const batcher = new FreshAgentStreamBatcher((action) => { actions.push(action) }, scheduler)

    batcher.flush(claude)
    expect(actions).toEqual([])
    expect(scheduled).toHaveLength(0)

    batcher.enqueue(claude, delta('x'))
    batcher.flush()
    expect(actions).toHaveLength(1)
    // The emptied queue cancelled its timer; the next op arms a new one.
    fire()
    expect(actions).toHaveLength(1)
    batcher.enqueue(claude, delta('y'))
    expect(scheduled.filter((entry) => !entry.cancelled)).toHaveLength(1)
    fire()
    expect(actions).toHaveLength(2)
  })
})
