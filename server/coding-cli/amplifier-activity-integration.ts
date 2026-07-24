/**
 * Composition root for Amplifier's events-driven activity tracking (plan
 * docs/plans/2026-07-08-amplifier-session-durability-plan.md §6/§9 Phase 2).
 *
 * Composes, per bound amplifier terminal: an events.jsonl tailer (offset-based,
 * Phase 1) → the pure reducer (Phase 1) → the tracker (applyLifecycle /
 * noteEventsSignalLost). Imitates the composition style of
 * `opencode-activity-integration.ts` but LAYERS on top of the frozen
 * `amplifier-activity-wiring.ts` (which keeps feeding the tracker PTY signals)
 * instead of replacing it. The integration attaches/detaches tailers — nothing
 * else: when the tailer degrades (schema mismatch, file reset, persistent read
 * errors, attach failure) the terminal's tracking reverts to idle-and-stop
 * (tracker.noteEventsSignalLost) with a single 'amplifier_events_lane_degraded'
 * warn. There is no timing-heuristic fallback (removed 2026-07-08).
 *
 * Reads are caller-driven (the tailer owns no watchers): a chokidar watch on the
 * session dir (session-indexer hygiene: ignoreInitial, close().catch(() => {});
 * the dir is watched — not the file — because events.jsonl may not exist yet at
 * attach time while the session dir does) plus the tracker's deadman force-read
 * requests (WSL2 inotify backstop).
 *
 * Path discovery stays OUTSIDE this module: callers hand attachTailer() an
 * explicit events path (Phase 3's locator) or provide resolveEventsPath (Phase 2:
 * indexer file path + provider.getLiveEventsPath).
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import chokidar from 'chokidar'
import {
  createAmplifierReducerState,
  reduceAmplifierEvent,
  type AmplifierReducerState,
} from './amplifier-events-reducer.js'
import {
  createAmplifierEventsTailer,
  type AmplifierEventsTailer,
  type AmplifierTailerFs,
} from './amplifier-events-tailer.js'
import type { AmplifierEventsForceReadRequest } from './amplifier-activity-tracker.js'
import type { AmplifierReducerEffect } from './amplifier-events-reducer.js'
import type { TerminalSessionBoundEvent } from '../terminal-stream/registry-events.js'

/**
 * Catch-up cap (adversarial finding C): an offset-0 attach whose backlog
 * exceeds this many bytes skips the catch-up drain entirely and attaches at
 * EOF instead (state stays idle; live records take over). Real events files
 * reach hundreds of MB — replaying them at attach is never acceptable.
 */
export const AMPLIFIER_CATCHUP_MAX_BYTES = 4 * 1024 * 1024

export type AmplifierEventsWatcher = {
  on(event: string, handler: (...args: any[]) => void): unknown
  close(): Promise<void>
}

export type AmplifierEventsWatchFactory = (
  watchPath: string,
  options: { ignoreInitial: boolean },
) => AmplifierEventsWatcher

type IntegrationLogger = {
  warn: (payload: object, message?: string) => void
}

type IntegrationTracker = {
  trackTerminal(input: { terminalId: string; sessionId?: string; at: number }): void
  noteEventsSignalLost(terminalId: string): void
  applyLifecycle(terminalId: string, effect: AmplifierReducerEffect): void
  on(event: string, handler: (...args: any[]) => void): unknown
  off(event: string, handler: (...args: any[]) => void): unknown
}

type IntegrationTerminalSnapshot = {
  terminalId: string
  mode: string
  status: string
  resumeSessionId?: string
}

type IntegrationRegistry = {
  list: () => Array<{ terminalId: string }>
  get: (terminalId: string) => IntegrationTerminalSnapshot | undefined | null
  on: (event: string, handler: (...args: any[]) => void) => void
  off: (event: string, handler: (...args: any[]) => void) => void
}

export type AmplifierActivityIntegrationInput = {
  registry: IntegrationRegistry
  tracker: IntegrationTracker
  /**
   * Resolve the live events.jsonl path for a bound session. Phase 2 wiring:
   * indexer.getFilePathForSession(sessionId, 'amplifier') →
   * provider.getLiveEventsPath(metadataPath). Returns undefined when the session
   * is not indexed yet (fresh, metadata.json not yet written) — Phase 3's locator
   * hands such sessions to attachTailer() with an explicit path instead.
   */
  resolveEventsPath: (sessionId: string) => string | undefined
  log?: IntegrationLogger
  now?: () => number
  /** Injected for tests; defaults to chokidar.watch. */
  watchImpl?: AmplifierEventsWatchFactory
  /** Injected for tests; passed through to the tailer. */
  fsImpl?: AmplifierTailerFs
}

export type AmplifierActivityIntegration = {
  /**
   * Attach (or re-attach) the events tailer for a terminal. Fresh sessions attach
   * at offset 0; resume attaches at EOF (plan §5 steps 6-7). Path discovery is the
   * caller's job — this keeps the integration layout-agnostic.
   */
  attachTailer(
    terminalId: string,
    sessionId: string,
    eventsPath: string,
    attachAt: 'start' | 'eof',
  ): Promise<void>
  dispose(): Promise<void>
  /** Diagnostics/tests (N3): live per-terminal serialization chain entries. */
  getAttachChainCount(): number
}

type Attachment = {
  terminalId: string
  sessionId: string
  eventsPath: string
  tailer: AmplifierEventsTailer
  watcher?: AmplifierEventsWatcher
  reducerState: AmplifierReducerState
  degraded: boolean
  closed: boolean
  // Finding C: true until the first drain after an offset-0 attach completes.
  // Catch-up records adopt state through the reducer but must NOT re-emit
  // turn.complete for turns that finished before the bind.
  catchingUp: boolean
  // `at` of the last suppressed turn.began, used to adopt a busy end-state once.
  catchUpBeganAt?: string
  // Wall-clock attach time: liveness floor for adopted catch-up state (an
  // in-flight turn whose prompt:submit ts is >120s old must not trigger an
  // instant deadman force-read right after bind — re-verification quirk).
  attachedAt: number
}

export function createAmplifierActivityIntegration(
  input: AmplifierActivityIntegrationInput,
): AmplifierActivityIntegration {
  const {
    registry,
    tracker,
    resolveEventsPath,
    log,
    now = () => Date.now(),
    watchImpl = (watchPath, options) => chokidar.watch(watchPath, options),
    fsImpl,
  } = input

  const attachments = new Map<string, Attachment>()
  // Per-terminal attach/detach serialization (adversarial finding B): binds can
  // cascade two attachTailer calls in the same tick (registry.bindSession →
  // onBound, then controller 'associated' → index.ts). Without serialization
  // both pass the `await detach()` gap and the second orphans the first's
  // watcher, double-pumping the file. Imitates the tailer's own serialize().
  const attachChains = new Map<string, Promise<void>>()
  let disposed = false
  const runSerialized = (terminalId: string, task: () => Promise<void>): Promise<void> => {
    const prev = attachChains.get(terminalId) ?? Promise.resolve()
    const next = prev.then(task, task)
    const tail = next.then(() => {}, () => {})
    attachChains.set(terminalId, tail)
    // N3: mirror-delete once the chain settles — otherwise the map grows one
    // settled-promise entry per terminalId forever. A newer queued task will
    // have replaced the stored tail, in which case this delete is skipped.
    void tail.then(() => {
      if (attachChains.get(terminalId) === tail) attachChains.delete(terminalId)
    })
    return next
  }

  // Existence/size probe only (never reads): fresh sessions create events.jsonl
  // lazily (E1), so the initial catch-up read must not run against a missing
  // file — the tailer would degrade on the stat error. Uses the injected fs in
  // tests. Returns undefined when the file does not exist (yet).
  const statSize = async (p: string): Promise<number | undefined> => {
    try {
      const stat = await (fsImpl ? fsImpl.stat(p) : fsp.stat(p))
      return stat.size
    } catch {
      return undefined
    }
  }

  const degrade = (attachment: Attachment, reason: string, message?: string): void => {
    if (attachment.degraded) return
    attachment.degraded = true
    // Signal-loss policy (plan §6, 2026-07-08): no timing fallback. The
    // terminal reverts to idle silently and stays events-less from here on.
    tracker.noteEventsSignalLost(attachment.terminalId)
    log?.warn({
      component: 'amplifier-activity-integration',
      event: 'amplifier_events_lane_degraded',
      terminalId: attachment.terminalId,
      sessionId: attachment.sessionId,
      reason,
      ...(message ? { message } : {}),
    }, 'Amplifier events tracking degraded; terminal reverted to idle (no busy/turn signals until re-attach).')
    const watcher = attachment.watcher
    attachment.watcher = undefined
    void watcher?.close().catch(() => {})
  }

  const pump = async (attachment: Attachment, kind: 'read' | 'force'): Promise<void> => {
    if (attachment.degraded || attachment.closed) return
    const result = kind === 'force'
      ? await attachment.tailer.forceRead()
      : await attachment.tailer.read()
    if (attachment.closed) return
    if (!result.ok) {
      degrade(attachment, result.reason, result.message)
      return
    }
    // Catch-up state-sync (finding C): the FIRST drain after an offset-0
    // attach covers records already on disk — turns that finished before the
    // bind. Their phase transitions are adopted through the reducer, but
    // turn.began/turn.completed emissions are suppressed; the final phase is
    // adopted exactly once below. Records read after catch-up are live.
    const catchUp = attachment.catchingUp
    for (const record of result.records) {
      const reduced = reduceAmplifierEvent(attachment.reducerState, record)
      attachment.reducerState = reduced.state
      for (const effect of reduced.effects) {
        if (effect.kind === 'lane.degrade') {
          degrade(attachment, effect.reason)
          return
        }
        if (catchUp && (effect.kind === 'turn.began' || effect.kind === 'turn.completed')) {
          if (effect.kind === 'turn.began') attachment.catchUpBeganAt = effect.at
          continue
        }
        tracker.applyLifecycle(attachment.terminalId, effect)
      }
    }
    if (catchUp) {
      attachment.catchingUp = false
      if (attachment.reducerState.phase === 'busy') {
        // Locator-fresh bind mid-turn: adopt the in-flight busy once; the live
        // prompt:complete emits the single completion for this turn. The `at`
        // is clamped to max(recordTs, attachTime) — liveness bookkeeping only
        // (updatedAt/lastObservedAt feed the deadman): a stale in-flight turn
        // must not look >120s silent the moment it is adopted. Completion-
        // ledger `at` semantics are untouched (only turn.completed reaches it).
        const recordAtMs = attachment.catchUpBeganAt ? Date.parse(attachment.catchUpBeganAt) : Number.NaN
        const clampedAtMs = Math.max(
          Number.isFinite(recordAtMs) ? recordAtMs : 0,
          attachment.attachedAt,
        )
        tracker.applyLifecycle(attachment.terminalId, {
          kind: 'turn.began',
          at: new Date(clampedAtMs).toISOString(),
        })
      }
    }
  }

  const detach = async (terminalId: string): Promise<void> => {
    const attachment = attachments.get(terminalId)
    if (!attachment) return
    attachment.closed = true
    attachments.delete(terminalId)
    const watcher = attachment.watcher
    attachment.watcher = undefined
    await watcher?.close().catch(() => {})
  }

  const doAttach = async (
    terminalId: string,
    sessionId: string,
    eventsPath: string,
    requestedAttachAt: 'start' | 'eof',
  ): Promise<void> => {
    if (disposed) return
    await detach(terminalId)
    try {
      await doAttachInner(terminalId, sessionId, eventsPath, requestedAttachAt)
    } catch (error) {
      // N2: a synchronous throw during setup (e.g. chokidar ENOSPC) must never
      // escape the serialized chain as an unhandled rejection. Clean up any
      // partial state and degrade this terminal (single warn via degrade()).
      const message = error instanceof Error ? error.message : String(error)
      const attachment = attachments.get(terminalId)
      if (attachment) {
        degrade(attachment, 'attach_error', message)
      } else {
        tracker.noteEventsSignalLost(terminalId)
        log?.warn({
          component: 'amplifier-activity-integration',
          event: 'amplifier_events_lane_degraded',
          terminalId,
          sessionId,
          reason: 'attach_error',
          message,
        }, 'Amplifier events tracking degraded; terminal reverted to idle (no busy/turn signals until re-attach).')
      }
    }
  }

  const doAttachInner = async (
    terminalId: string,
    sessionId: string,
    eventsPath: string,
    requestedAttachAt: 'start' | 'eof',
  ): Promise<void> => {
    let attachAt = requestedAttachAt
    let fileExists = requestedAttachAt !== 'start'
    if (requestedAttachAt === 'start') {
      const size = await statSize(eventsPath)
      fileExists = size !== undefined
      if (size !== undefined && size > AMPLIFIER_CATCHUP_MAX_BYTES) {
        // Finding C cap: never replay a huge backlog — attach at EOF instead.
        attachAt = 'eof'
        log?.warn({
          component: 'amplifier-activity-integration',
          event: 'amplifier_events_catchup_skipped',
          terminalId,
          sessionId,
          sizeBytes: size,
          capBytes: AMPLIFIER_CATCHUP_MAX_BYTES,
        }, 'Amplifier events backlog exceeds the catch-up cap; attaching at EOF (live records take over).')
      }
    }

    const attachment: Attachment = {
      terminalId,
      sessionId,
      eventsPath,
      tailer: createAmplifierEventsTailer({
        filePath: eventsPath,
        attachAt,
        ...(fsImpl ? { fsImpl } : {}),
      }),
      reducerState: createAmplifierReducerState(),
      degraded: false,
      closed: false,
      // Only an offset-0 attach over an existing file has history to suppress;
      // a not-yet-created file has zero records on disk, so its first read is
      // live by definition.
      catchingUp: attachAt === 'start' && fileExists,
      attachedAt: now(),
    }
    attachments.set(terminalId, attachment)

    // Watch the session DIR (exists once the session exists — E1), not the file,
    // so a not-yet-created events.jsonl is picked up on 'add'. ignoreInitial per
    // session-indexer hygiene; the initial pump below covers pre-existing content.
    const resolvedEventsPath = path.resolve(eventsPath)
    const watcher = watchImpl(path.dirname(eventsPath), { ignoreInitial: true })
    const onFileEvent = (changedPath: unknown) => {
      if (typeof changedPath !== 'string') return
      if (path.resolve(changedPath) !== resolvedEventsPath) return
      void pump(attachment, 'read')
    }
    watcher.on('add', onFileEvent)
    watcher.on('change', onFileEvent)
    watcher.on('error', (error: unknown) => {
      degrade(attachment, 'watch_error', error instanceof Error ? error.message : String(error))
    })
    attachment.watcher = watcher

    const attached = await attachment.tailer.attach()
    if (attachment.closed) return
    if (!attached.ok) {
      degrade(attachment, attached.reason, attached.message)
      return
    }

    // Idempotent: production emits 'terminal.session.bound' before
    // 'terminal.created' (see amplifier-activity-wiring.ts), so ensure the
    // tracker record exists before lifecycle effects arrive.
    tracker.trackTerminal({ terminalId, sessionId, at: now() })

    if (requestedAttachAt === 'start' && !fileExists) {
      // events.jsonl may not exist yet (lazy creation, E1): leave the first read
      // to the dir watcher's 'add' event instead of degrading on a stat error.
      return
    }
    if (attachment.closed) return

    // Initial drain: offset-0 (fresh) runs the catch-up state-sync over existing
    // records (finding C); EOF (resume / capped backlog) is a no-op read.
    await pump(attachment, 'read')
  }

  const attachTailer = (
    terminalId: string,
    sessionId: string,
    eventsPath: string,
    attachAt: 'start' | 'eof',
  ): Promise<void> => runSerialized(
    terminalId,
    () => doAttach(terminalId, sessionId, eventsPath, attachAt),
  )

  const onBound = (event: TerminalSessionBoundEvent) => {
    if (event.provider !== 'amplifier') return
    const eventsPath = resolveEventsPath(event.sessionId)
    if (!eventsPath) return
    // Resume binds attach at EOF (E7: session:resume appends to the same file);
    // everything else is a fresh session → offset 0 (plan §5 steps 6-7).
    const attachAt = event.reason === 'resume' ? 'eof' : 'start'
    void attachTailer(event.terminalId, event.sessionId, eventsPath, attachAt)
  }

  const onExit = (event: { terminalId?: string }) => {
    if (!event.terminalId) return
    const terminalId = event.terminalId
    // Serialized with attaches (finding B): an exit racing a queued attach must
    // close whatever that attach creates, not just the current attachment.
    void runSerialized(terminalId, () => detach(terminalId))
  }

  const onForceRead = (request: AmplifierEventsForceReadRequest) => {
    const attachment = attachments.get(request.terminalId)
    if (!attachment) return
    void pump(attachment, 'force')
  }

  registry.on('terminal.session.bound', onBound)
  registry.on('terminal.exit', onExit)
  tracker.on('events.force-read', onForceRead)

  // Construction-order catch-up: amplifier terminals that were created and
  // session-bound BEFORE this integration subscribed (wiring-order races during
  // startup) would otherwise never get a tailer. PTYs do not survive a server
  // restart, so this is purely about same-process ordering. EOF attach: their
  // events file pre-exists and history must not be replayed as live turns.
  for (const listed of registry.list()) {
    const record = registry.get(listed.terminalId)
    if (!record || record.mode !== 'amplifier' || record.status !== 'running') continue
    if (!record.resumeSessionId) continue
    const eventsPath = resolveEventsPath(record.resumeSessionId)
    if (!eventsPath) continue
    void attachTailer(record.terminalId, record.resumeSessionId, eventsPath, 'eof')
  }

  return {
    attachTailer,
    getAttachChainCount: () => attachChains.size,
    async dispose() {
      disposed = true
      registry.off('terminal.session.bound', onBound)
      registry.off('terminal.exit', onExit)
      tracker.off('events.force-read', onForceRead)
      // Serialize behind any in-flight/queued attach so the last watcher of a
      // same-tick attach cascade is closed too (finding B).
      const terminalIds = Array.from(new Set([...attachments.keys(), ...attachChains.keys()]))
      await Promise.all(terminalIds.map((terminalId) => runSerialized(terminalId, () => detach(terminalId))))
      attachChains.clear()
    },
  }
}
