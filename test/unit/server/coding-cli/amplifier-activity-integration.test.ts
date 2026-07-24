import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import {
  AMPLIFIER_BUSY_DEADMAN_MS,
  AmplifierActivityTracker,
  type AmplifierTurnCompleteEvent,
} from '../../../../server/coding-cli/amplifier-activity-tracker.js'
import {
  AMPLIFIER_CATCHUP_MAX_BYTES,
  createAmplifierActivityIntegration,
  type AmplifierEventsWatchFactory,
  type AmplifierEventsWatcher,
} from '../../../../server/coding-cli/amplifier-activity-integration.js'
import type { AmplifierTailerFs } from '../../../../server/coding-cli/amplifier-events-tailer.js'

const SCHEMA = '"schema": {"name": "amplifier.log", "ver": "1.0.0"}'

// Records carry ISO timestamps derived from small epoch-ms values so tracker
// timestamps (parsed from record ts) are easy to reason about in assertions.
function line(event: string, atMs = 1000, extra = ''): string {
  return `{"ts": "${new Date(atMs).toISOString()}", "lvl": "INFO", ${SCHEMA}, `
    + `"event": "${event}", "session_id": "session-1", "data": {"parent_id": null${extra}}}\n`
}

function badSchemaLine(event: string, atMs = 1000): string {
  return `{"ts": "${new Date(atMs).toISOString()}", "schema": {"name": "amplifier.log", "ver": "2.0.0"}, `
    + `"event": "${event}", "session_id": "session-1", "data": {"parent_id": null}}\n`
}

type FakeFsStore = {
  fsImpl: AmplifierTailerFs
  write(path: string, text: string): void
  append(path: string, text: string): void
  failStat(path: string): void
}

function createFakeFsStore(): FakeFsStore {
  const files = new Map<string, Buffer>()
  const statFailures = new Set<string>()
  const fsImpl: AmplifierTailerFs = {
    async stat(path) {
      if (statFailures.has(path)) throw new Error('EIO: injected stat failure')
      const content = files.get(path)
      if (!content) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { size: content.length }
    },
    async open(path) {
      return {
        async read(buffer: Buffer, offset: number, length: number, position: number) {
          const content = files.get(path) ?? Buffer.alloc(0)
          const slice = content.subarray(position, position + length)
          slice.copy(buffer, offset)
          return { bytesRead: slice.length }
        },
        async close() {},
      }
    },
  }
  return {
    fsImpl,
    write(path, text) {
      files.set(path, Buffer.from(text, 'utf8'))
    },
    append(path, text) {
      files.set(path, Buffer.concat([files.get(path) ?? Buffer.alloc(0), Buffer.from(text, 'utf8')]))
    },
    failStat(path) {
      statFailures.add(path)
    },
  }
}

type FakeWatcher = AmplifierEventsWatcher & {
  watchedPath: string
  closed: boolean
  fire(event: string, path: string): void
}

function createFakeWatchFactory(): { factory: AmplifierEventsWatchFactory; watchers: FakeWatcher[] } {
  const watchers: FakeWatcher[] = []
  const factory: AmplifierEventsWatchFactory = (watchedPath) => {
    const handlers = new Map<string, Array<(...args: any[]) => void>>()
    const watcher: FakeWatcher = {
      watchedPath,
      closed: false,
      on(event, handler) {
        const list = handlers.get(event) ?? []
        list.push(handler)
        handlers.set(event, list)
        return watcher
      },
      async close() {
        watcher.closed = true
      },
      fire(event, path) {
        for (const handler of handlers.get(event) ?? []) handler(path)
      },
    }
    watchers.push(watcher)
    return watcher
  }
  return { factory, watchers }
}

class FakeRegistry extends EventEmitter {
  terminals = new Map<string, { terminalId: string; mode: string; status: string; resumeSessionId?: string }>()
  list() {
    return Array.from(this.terminals.values()).map(({ terminalId }) => ({ terminalId }))
  }
  get(terminalId: string) {
    return this.terminals.get(terminalId)
  }
}

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

const EVENTS_PATH = '/fake/projects/-work/sessions/session-1/events.jsonl'

function setup(options: {
  resolveEventsPath?: (sessionId: string) => string | undefined
} = {}) {
  const registry = new FakeRegistry()
  const tracker = new AmplifierActivityTracker()
  const completions: AmplifierTurnCompleteEvent[] = []
  tracker.on('turn.complete', (event: AmplifierTurnCompleteEvent) => completions.push(event))
  const fsStore = createFakeFsStore()
  const { factory, watchers } = createFakeWatchFactory()
  const warn = vi.fn()
  const integration = createAmplifierActivityIntegration({
    registry,
    tracker,
    resolveEventsPath: options.resolveEventsPath ?? (() => EVENTS_PATH),
    log: { warn },
    watchImpl: factory,
    fsImpl: fsStore.fsImpl,
  })
  return { registry, tracker, completions, fsStore, watchers, warn, integration }
}

function bound(registry: FakeRegistry, input: {
  terminalId?: string
  sessionId?: string
  reason?: 'start' | 'resume' | 'association'
}) {
  registry.emit('terminal.session.bound', {
    terminalId: input.terminalId ?? 't1',
    provider: 'amplifier',
    sessionId: input.sessionId ?? 'session-1',
    reason: input.reason ?? 'association',
  })
}

describe('amplifier activity integration', () => {
  it('fresh bind over already-finished turns adopts final state without phantom completions (catch-up suppression)', async () => {
    const { registry, tracker, completions, fsStore, watchers } = setup()
    // Fast-path/coordinator binds fire only AFTER metadata.json lands (= after
    // the first prompt:complete), so the file already holds finished turns.
    fsStore.write(
      EVENTS_PATH,
      line('session:start', 1000)
      + line('session:config', 1010, ', "raw": {"working_dir": "/work"}')
      + line('prompt:submit', 2000)
      + line('prompt:complete', 5000)
      + line('prompt:submit', 6000)
      + line('prompt:complete', 7000),
    )

    bound(registry, { reason: 'association' })
    await flush()

    // Catch-up drain: state adopted (idle), ZERO replayed turn.completes —
    // turns that finished before the bind are history, not live turns (finding C).
    expect(completions).toHaveLength(0)
    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'idle', sessionId: 'session-1' })
    expect(watchers).toHaveLength(1)
    expect(watchers[0].watchedPath).toBe('/fake/projects/-work/sessions/session-1')

    // Records appended AFTER catch-up are live and emit normally.
    fsStore.append(EVENTS_PATH, line('prompt:submit', 8000))
    watchers[0].fire('change', EVENTS_PATH)
    await flush()
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    fsStore.append(EVENTS_PATH, line('prompt:complete', 9000))
    watchers[0].fire('change', EVENTS_PATH)
    await flush()
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ terminalId: 't1', at: 9000, completionSeq: 1 })
  })

  it('locator bind mid-turn: catch-up adopts busy, the live prompt:complete emits exactly one completion', async () => {
    const { tracker, completions, fsStore, watchers, integration } = setup()
    // Locator-fresh bind: the file holds an in-flight turn at attach time.
    // Record timestamps are ANCIENT epoch values (2000ms = 1970): without the
    // staleness clamp the adopted busy would look >120s silent and trigger an
    // instant deadman force-read on the first sweep (re-verify quirk).
    fsStore.write(
      EVENTS_PATH,
      line('session:start', 1000)
      + line('session:config', 1010, ', "raw": {"working_dir": "/work"}')
      + line('prompt:submit', 2000),
    )

    const beforeAttach = Date.now()
    await integration.attachTailer('t1', 'session-1', EVENTS_PATH, 'start')
    await flush()
    // Catch-up ends busy (adopted once), with no completion emitted yet.
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)
    // Liveness bookkeeping clamped to attach time: no instant-deadman on
    // adoption of an old in-flight turn.
    expect(tracker.getActivity('t1')!.updatedAt).toBeGreaterThanOrEqual(beforeAttach)

    fsStore.append(EVENTS_PATH, line('prompt:complete', 5000))
    watchers[0].fire('change', EVENTS_PATH)
    await flush()
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ terminalId: 't1', at: 5000, completionSeq: 1 })
  })

  it('skips catch-up entirely and attaches at EOF when the backlog exceeds the cap', async () => {
    const { registry, tracker, completions, fsStore, watchers } = setup()
    // Real events files reach hundreds of MB; replaying them at attach would
    // hold the process hostage. Over the cap: attach at EOF, stay idle.
    fsStore.write(EVENTS_PATH, 'x'.repeat(AMPLIFIER_CATCHUP_MAX_BYTES + 1024) + '\n')

    bound(registry, { reason: 'association' })
    await flush()
    expect(completions).toHaveLength(0)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')

    // Live records take over from EOF.
    fsStore.append(EVENTS_PATH, line('prompt:submit', 9000))
    watchers[0].fire('change', EVENTS_PATH)
    await flush()
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
  })

  it('same-tick double attach keeps exactly one live watcher and one completion; dispose closes everything', async () => {
    const { tracker, completions, fsStore, watchers, integration } = setup()
    fsStore.write(EVENTS_PATH, line('session:start', 1000))

    // Probe-reproduced cascade (finding B): bindSession → onBound attach #1 and
    // controller 'associated' → attach #2 in the same synchronous cascade.
    const first = integration.attachTailer('t1', 'session-1', EVENTS_PATH, 'start')
    const second = integration.attachTailer('t1', 'session-1', EVENTS_PATH, 'start')
    await Promise.all([first, second])
    await flush()

    expect(watchers).toHaveLength(2)
    expect(watchers.filter((watcher) => !watcher.closed)).toHaveLength(1)

    // A full live turn pumped through BOTH watchers still emits exactly once
    // (the orphaned first attachment is closed, not double-pumping).
    fsStore.append(EVENTS_PATH, line('prompt:submit', 2000) + line('prompt:complete', 5000))
    for (const watcher of watchers) watcher.fire('change', EVENTS_PATH)
    await flush()
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ terminalId: 't1', at: 5000, completionSeq: 1 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')

    await integration.dispose()
    expect(watchers.every((watcher) => watcher.closed)).toBe(true)
  })

  it('resume bind attaches at EOF: history is not replayed, later appends flow through', async () => {
    const { registry, tracker, completions, fsStore, watchers } = setup()
    fsStore.write(
      EVENTS_PATH,
      line('session:start', 1000) + line('prompt:submit', 2000) + line('prompt:complete', 5000),
    )

    bound(registry, { reason: 'resume' })
    await flush()
    expect(completions).toHaveLength(0)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')

    fsStore.append(EVENTS_PATH, line('session:resume', 6000) + line('prompt:submit', 7000))
    watchers[0].fire('change', EVENTS_PATH)
    await flush()
    expect(tracker.getActivity('t1')?.phase).toBe('busy')

    fsStore.append(EVENTS_PATH, line('prompt:complete', 9000))
    watchers[0].fire('change', EVENTS_PATH)
    await flush()
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ terminalId: 't1', at: 9000, completionSeq: 1 })
  })

  it('fresh bind tolerates a not-yet-existing events file (dir watcher drives the first read)', async () => {
    const { registry, tracker, fsStore, watchers, warn } = setup()

    bound(registry, { reason: 'association' })
    await flush()
    expect(warn).not.toHaveBeenCalled()
    expect(watchers).toHaveLength(1)

    fsStore.write(EVENTS_PATH, line('session:start', 1000) + line('prompt:submit', 2000))
    watchers[0].fire('add', EVENTS_PATH)
    await flush()
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
  })

  it('reducer lane.degrade stops events tracking once with a single warn and closes the watcher', async () => {
    const { registry, tracker, fsStore, watchers, warn } = setup()
    const signalLostSpy = vi.spyOn(tracker, 'noteEventsSignalLost')
    fsStore.write(EVENTS_PATH, line('session:start', 1000))

    bound(registry, {})
    await flush()
    expect(warn).not.toHaveBeenCalled()

    // The tailer's schema gate only checks the first record of the file; a later
    // bad-schema record reaches the reducer, which degrades the tracking.
    fsStore.append(EVENTS_PATH, badSchemaLine('prompt:submit', 2000))
    watchers[0].fire('change', EVENTS_PATH)
    await flush()

    expect(signalLostSpy).toHaveBeenCalledWith('t1')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatchObject({
      event: 'amplifier_events_lane_degraded',
      terminalId: 't1',
      reason: 'schema_version_unsupported',
    })
    expect(watchers[0].closed).toBe(true)

    // Further watcher noise is ignored: no second warn, no churn.
    fsStore.append(EVENTS_PATH, line('prompt:submit', 3000))
    watchers[0].fire('change', EVENTS_PATH)
    await flush()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
  })

  it('tailer error mid-turn degrades once: idle with NO completion (no timing fallback)', async () => {
    const { registry, tracker, completions, fsStore, watchers, warn } = setup()
    fsStore.write(EVENTS_PATH, line('session:start', 1000))
    bound(registry, {})
    await flush()

    fsStore.append(EVENTS_PATH, line('prompt:submit', 2000))
    watchers[0].fire('change', EVENTS_PATH)
    await flush()
    expect(tracker.getActivity('t1')?.phase).toBe('busy')

    fsStore.failStat(EVENTS_PATH)
    watchers[0].fire('change', EVENTS_PATH)
    await flush()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatchObject({
      event: 'amplifier_events_lane_degraded',
      terminalId: 't1',
      reason: 'read_error',
    })
    // Signal-loss policy: the in-flight turn is dropped — idle silently, no
    // fabricated turn.complete, and nothing ever finishes it later.
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(0)
    expect(watchers[0].closed).toBe(true)
  })

  it('deadman force-read recovers a completion missed by the watcher (WSL2 backstop)', async () => {
    const { registry, tracker, completions, fsStore, watchers } = setup()
    fsStore.write(EVENTS_PATH, line('session:start', 1000))
    bound(registry, {})
    await flush()

    fsStore.append(EVENTS_PATH, line('prompt:submit', 2000))
    watchers[0].fire('change', EVENTS_PATH)
    await flush()
    expect(tracker.getActivity('t1')?.phase).toBe('busy')

    // The completion lands on disk but the watcher never fires (dropped inotify).
    fsStore.append(EVENTS_PATH, line('prompt:complete', 5000))
    tracker.expire(2000 + AMPLIFIER_BUSY_DEADMAN_MS + 1)
    await flush()

    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ terminalId: 't1', at: 5000, completionSeq: 1 })
  })

  it('deadman force-read with nothing new on disk stays busy (genuine long turn)', async () => {
    const { registry, tracker, completions, fsStore, watchers } = setup()
    fsStore.write(EVENTS_PATH, line('session:start', 1000))
    bound(registry, {})
    await flush()
    fsStore.append(EVENTS_PATH, line('prompt:submit', 2000))
    watchers[0].fire('change', EVENTS_PATH)
    await flush()

    tracker.expire(2000 + AMPLIFIER_BUSY_DEADMAN_MS + 1)
    await flush()
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)
  })

  it('terminal exit closes the watcher and stops all reads (leak assertion)', async () => {
    const { registry, tracker, fsStore, watchers, integration } = setup()
    fsStore.write(EVENTS_PATH, line('session:start', 1000))
    bound(registry, {})
    await flush()
    expect(watchers).toHaveLength(1)
    expect(watchers[0].closed).toBe(false)

    registry.emit('terminal.exit', { terminalId: 't1' })
    // Mirror production: the frozen wiring removes the tracker state on exit.
    tracker.noteExit({ terminalId: 't1' })
    await flush()
    expect(watchers.every((watcher) => watcher.closed)).toBe(true)

    fsStore.append(EVENTS_PATH, line('prompt:submit', 2000))
    watchers[0].fire('change', EVENTS_PATH)
    await flush()
    expect(tracker.getActivity('t1')).toBeUndefined()

    // N3: the per-terminal serialization chain entry is mirror-deleted once it
    // settles — bind→exit cycles must not grow the map forever.
    expect(integration.getAttachChainCount()).toBe(0)

    // A second bind→exit cycle also returns to zero.
    bound(registry, { terminalId: 't2', sessionId: 'session-1' })
    await flush()
    expect(integration.getAttachChainCount()).toBe(0)
    registry.emit('terminal.exit', { terminalId: 't2' })
    await flush()
    expect(integration.getAttachChainCount()).toBe(0)
  })

  it('a synchronous throw during attach degrades the terminal instead of escaping the chain (N2)', async () => {
    const registry = new FakeRegistry()
    const tracker = new AmplifierActivityTracker()
    const signalLostSpy = vi.spyOn(tracker, 'noteEventsSignalLost')
    const fsStore = createFakeFsStore()
    fsStore.write(EVENTS_PATH, line('session:start', 1000))
    const warn = vi.fn()
    const { factory, watchers } = createFakeWatchFactory()
    // e.g. chokidar hitting ENOSPC (inotify watch limit) throws synchronously
    // on the FIRST attach; a later attach succeeds (limit freed up).
    let watchCalls = 0
    const integration = createAmplifierActivityIntegration({
      registry,
      tracker,
      resolveEventsPath: () => EVENTS_PATH,
      log: { warn },
      watchImpl: (watchPath, options) => {
        watchCalls += 1
        if (watchCalls === 1) {
          throw new Error('ENOSPC: System limit for number of file watchers reached')
        }
        return factory(watchPath, options)
      },
      fsImpl: fsStore.fsImpl,
    })

    // Must RESOLVE (contained), never escape as an unhandled rejection.
    await expect(integration.attachTailer('t1', 'session-1', EVENTS_PATH, 'start'))
      .resolves.toBeUndefined()
    expect(signalLostSpy).toHaveBeenCalledWith('t1')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatchObject({
      event: 'amplifier_events_lane_degraded',
      terminalId: 't1',
      reason: 'attach_error',
    })

    // The serialized chain recovered: the NEXT attach for the same terminal
    // works normally (watcher created, events tracking live again).
    await expect(integration.attachTailer('t1', 'session-1', EVENTS_PATH, 'start'))
      .resolves.toBeUndefined()
    await flush()
    expect(watchers).toHaveLength(1)
    expect(watchers[0].closed).toBe(false)
    fsStore.append(EVENTS_PATH, line('prompt:submit', 2000))
    watchers[0].fire('change', EVENTS_PATH)
    await flush()
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    // Still exactly one attach_error warn: the recovery attach warned nothing.
    expect(warn).toHaveBeenCalledTimes(1)

    // Dispose settles cleanly too.
    await expect(integration.dispose()).resolves.toBeUndefined()
    expect(watchers.every((watcher) => watcher.closed)).toBe(true)
  })

  it('re-attaching a terminal closes the previous watcher first', async () => {
    const { fsStore, watchers, integration } = setup()
    fsStore.write(EVENTS_PATH, line('session:start', 1000))
    await integration.attachTailer('t1', 'session-1', EVENTS_PATH, 'eof')
    await integration.attachTailer('t1', 'session-1', EVENTS_PATH, 'eof')
    await flush()
    expect(watchers).toHaveLength(2)
    expect(watchers[0].closed).toBe(true)
    expect(watchers[1].closed).toBe(false)
  })

  it('attaches at EOF for already-running bound amplifier terminals at construction', async () => {
    const registry = new FakeRegistry()
    registry.terminals.set('t-restored', {
      terminalId: 't-restored',
      mode: 'amplifier',
      status: 'running',
      resumeSessionId: 'session-1',
    })
    registry.terminals.set('t-shell', { terminalId: 't-shell', mode: 'shell', status: 'running' })
    const tracker = new AmplifierActivityTracker()
    const completions: AmplifierTurnCompleteEvent[] = []
    tracker.on('turn.complete', (event: AmplifierTurnCompleteEvent) => completions.push(event))
    const fsStore = createFakeFsStore()
    fsStore.write(EVENTS_PATH, line('session:start', 1000) + line('prompt:submit', 2000) + line('prompt:complete', 3000))
    const { factory, watchers } = createFakeWatchFactory()
    const integration = createAmplifierActivityIntegration({
      registry,
      tracker,
      resolveEventsPath: () => EVENTS_PATH,
      watchImpl: factory,
      fsImpl: fsStore.fsImpl,
    })
    await flush()

    // EOF attach: pre-existing history is never replayed as live turns.
    expect(watchers).toHaveLength(1)
    expect(completions).toHaveLength(0)

    fsStore.append(EVENTS_PATH, line('prompt:submit', 9000))
    watchers[0].fire('change', EVENTS_PATH)
    await flush()
    expect(tracker.getActivity('t-restored')?.phase).toBe('busy')
    await integration.dispose()
  })

  it('ignores binds whose session has no resolvable events path (fresh, unindexed — Phase 3 territory)', async () => {
    const { registry, watchers, warn } = setup({ resolveEventsPath: () => undefined })
    bound(registry, {})
    await flush()
    expect(watchers).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('ignores non-amplifier binds', async () => {
    const { registry, watchers } = setup()
    registry.emit('terminal.session.bound', {
      terminalId: 't1',
      provider: 'claude',
      sessionId: 'session-1',
      reason: 'resume',
    })
    await flush()
    expect(watchers).toHaveLength(0)
  })

  it('dispose unsubscribes and closes every watcher', async () => {
    const { registry, fsStore, watchers, integration } = setup()
    fsStore.write(EVENTS_PATH, line('session:start', 1000))
    bound(registry, {})
    await flush()
    expect(watchers).toHaveLength(1)

    await integration.dispose()
    expect(watchers.every((watcher) => watcher.closed)).toBe(true)

    // Listener removed: a new bound event no longer creates watchers.
    bound(registry, { terminalId: 't2' })
    await flush()
    expect(watchers).toHaveLength(1)
  })
})
