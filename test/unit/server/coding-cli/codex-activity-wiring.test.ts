import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { wireCodexActivityTracker } from '../../../../server/coding-cli/codex-activity-wiring'
import type { ProjectGroup } from '../../../../server/coding-cli/types'

class FakeRegistry extends EventEmitter {}

class FakeCodingCliIndexer {
  private projects: ProjectGroup[] = []
  private readonly handlers = new Set<(projects: ProjectGroup[]) => void>()

  getProjects(): ProjectGroup[] {
    return this.projects
  }

  onUpdate(handler: (projects: ProjectGroup[]) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  emitUpdate(projects: ProjectGroup[]): void {
    this.projects = projects
    for (const handler of this.handlers) {
      handler(projects)
    }
  }
}

describe('wireCodexActivityTracker', () => {
  it('feeds app-server turn started/completed registry events into the tracker', () => {
    const registry = new FakeRegistry()
    const indexer = new FakeCodingCliIndexer()
    const { tracker, dispose } = wireCodexActivityTracker({
      registry: registry as any,
      codingCliIndexer: indexer,
      now: () => 1_000,
      setIntervalFn: (() => 0) as any,
      clearIntervalFn: vi.fn() as any,
    })
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))

    registry.emit('terminal.session.bound', {
      terminalId: 'term-1',
      provider: 'codex',
      sessionId: 'session-1',
      reason: 'association',
    })
    registry.emit('codex.turn.started', { terminalId: 'term-1', at: 1_100 })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'busy',
      acceptedStartAt: 1_100,
    })

    registry.emit('codex.turn.completed', { terminalId: 'term-1', at: 1_200 })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'idle',
      lastClearedAt: 1_200,
    })
    expect(completions).toEqual([{ terminalId: 'term-1', sessionId: 'session-1', at: 1_200, completionSeq: 1 }])

    dispose()
  })

  it('removes app-server turn event listeners on dispose', () => {
    const registry = new FakeRegistry()
    const indexer = new FakeCodingCliIndexer()
    const { dispose } = wireCodexActivityTracker({
      registry: registry as any,
      codingCliIndexer: indexer,
      now: () => 1_000,
      setIntervalFn: (() => 0) as any,
      clearIntervalFn: vi.fn() as any,
    })

    expect(registry.listenerCount('codex.turn.started')).toBe(1)
    expect(registry.listenerCount('codex.turn.completed')).toBe(1)

    dispose()

    expect(registry.listenerCount('codex.turn.started')).toBe(0)
    expect(registry.listenerCount('codex.turn.completed')).toBe(0)
  })
})
