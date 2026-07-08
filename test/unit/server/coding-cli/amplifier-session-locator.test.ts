/**
 * AmplifierSessionLocator tests (plan 2026-07-08 §5 / §9 Phase 3).
 *
 * Uses a real temp Amplifier home (mkdtemp) and real chokidar — the pattern of
 * amplifier-provider.test.ts (fake home) combined with session-indexer-style
 * watcher assertions. Windows are shortened via injected windowMs so tests stay
 * bounded; every wait is polled with a generous timeout.
 */
import { EventEmitter } from 'events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import chokidar from 'chokidar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AMPLIFIER_DIR_APPEAR_WINDOW_MS,
  AMPLIFIER_DIR_PRE_EPSILON_MS,
  AmplifierSessionLocator,
  type AmplifierLocatorWatchFactory,
  type AmplifierSessionLocatedEvent,
} from '../../../../server/coding-cli/amplifier-session-locator.js'

const SCHEMA = { name: 'amplifier.log', ver: '1.0.0' }

function eventsJsonl(input: {
  sessionId: string
  cwd: string
  parentId?: string | null
  firstEvent?: string
}): string {
  const start = {
    ts: new Date().toISOString(),
    lvl: 'INFO',
    schema: SCHEMA,
    event: input.firstEvent ?? 'session:start',
    session_id: input.sessionId,
    data: { parent_id: input.parentId ?? null },
  }
  const config = {
    ts: new Date().toISOString(),
    lvl: 'INFO',
    schema: SCHEMA,
    event: 'session:config',
    session_id: input.sessionId,
    data: { raw: { working_dir: input.cwd, project_dir: input.cwd, project_slug: 'slug' } },
  }
  return `${JSON.stringify(start)}\n${JSON.stringify(config)}\n`
}

type Harness = {
  home: string
  cwd: string
  registry: EventEmitter
  locator: AmplifierSessionLocator
  located: AmplifierSessionLocatedEvent[]
  warn: ReturnType<typeof vi.fn>
  /** Every path handed to the watch factory (finding A: must stay inside home). */
  watchPaths: string[]
  writeSessionDir(id: string, opts?: {
    cwd?: string
    parentId?: string | null
    omitEvents?: boolean
    firstEvent?: string
  }): Promise<string>
  arm(terminalId: string, opts?: { cwd?: string; resumeSessionId?: string }): void
  submit(terminalId: string): void
}

const cleanups: Array<() => Promise<void>> = []

// Deterministic wait helpers (finding M): poll observable locator state instead
// of sleeping and asserting a negative.
function discoveryState(h: Harness, dir: string): string | undefined {
  return ((h.locator as any).discoveries as Map<string, { state: string }>).get(path.resolve(dir))?.state
}

function hasDiscovery(h: Harness, dir: string): boolean {
  return ((h.locator as any).discoveries as Map<string, unknown>).has(path.resolve(dir))
}

/** True once the terminal's correlation window (opened by submit) has fully resolved. */
function windowResolved(h: Harness, terminalId: string): boolean {
  const armed = ((h.locator as any).armed as Map<string, { window?: unknown }>).get(terminalId)
  return !!armed && armed.window === undefined
}

/** Watcher that emits 'ready' but never announces anything (findings J/N1). */
function inertWatchFactory(): AmplifierLocatorWatchFactory {
  return () => {
    const emitter = new EventEmitter()
    setImmediate(() => emitter.emit('ready'))
    return {
      on: (event: string, handler: (...args: any[]) => void) => emitter.on(event, handler),
      close: async () => {},
    }
  }
}

async function createHarness(options: {
  windowMs?: number
  probeTimeoutMs?: number
  createProjectsDir?: boolean
  /** Finding A: simulate a completely absent amplifier home. */
  removeHome?: boolean
  watchImpl?: AmplifierLocatorWatchFactory
  /** Finding H: terminals that exist in the registry before construction. */
  preexistingTerminals?: Array<{ terminalId: string; cwd?: string; resumeSessionId?: string }>
} = {}): Promise<Harness> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-amp-locator-home-'))
  const cwdRaw = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-amp-locator-cwd-'))
  const cwd = await fsp.realpath(cwdRaw)
  if (options.removeHome) {
    await fsp.rm(home, { recursive: true, force: true })
  } else if (options.createProjectsDir !== false) {
    await fsp.mkdir(path.join(home, 'projects'), { recursive: true })
  }

  const registry = new EventEmitter()
  if (options.preexistingTerminals) {
    const records = options.preexistingTerminals.map((terminal) => ({
      terminalId: terminal.terminalId,
      mode: 'amplifier',
      status: 'running',
      cwd: terminal.cwd ?? cwd,
      resumeSessionId: terminal.resumeSessionId,
    }))
    ;(registry as any).list = () => records.map(({ terminalId }) => ({ terminalId }))
    ;(registry as any).get = (terminalId: string) => records.find((r) => r.terminalId === terminalId)
  }
  const warn = vi.fn()
  const watchPaths: string[] = []
  const innerWatch: AmplifierLocatorWatchFactory = options.watchImpl
    ?? ((watchPath, watchOptions) => chokidar.watch(watchPath, watchOptions))
  const locator = new AmplifierSessionLocator({
    registry: registry as any,
    amplifierHome: home,
    log: { warn },
    windowMs: options.windowMs ?? 400,
    probeTimeoutMs: options.probeTimeoutMs ?? 2_000,
    probePollMs: 25,
    watchImpl: (watchPath, watchOptions) => {
      watchPaths.push(watchPath)
      return innerWatch(watchPath, watchOptions)
    },
  })
  const located: AmplifierSessionLocatedEvent[] = []
  locator.on('session.located', (event: AmplifierSessionLocatedEvent) => located.push(event))

  cleanups.push(async () => {
    await locator.dispose()
    await fsp.rm(home, { recursive: true, force: true })
    await fsp.rm(cwdRaw, { recursive: true, force: true })
  })

  return {
    home,
    cwd,
    registry,
    locator,
    located,
    warn,
    watchPaths,
    async writeSessionDir(id, opts = {}) {
      const dir = path.join(home, 'projects', 'slug', 'sessions', id)
      await fsp.mkdir(dir, { recursive: true })
      if (!opts.omitEvents) {
        await fsp.writeFile(
          path.join(dir, 'events.jsonl'),
          eventsJsonl({
            sessionId: id,
            cwd: opts.cwd ?? cwd,
            parentId: opts.parentId ?? null,
            firstEvent: opts.firstEvent,
          }),
          'utf8',
        )
      }
      return dir
    },
    arm(terminalId, opts = {}) {
      registry.emit('terminal.created', {
        terminalId,
        mode: 'amplifier',
        status: 'running',
        cwd: opts.cwd ?? cwd,
        resumeSessionId: opts.resumeSessionId,
      })
    },
    submit(terminalId) {
      registry.emit('terminal.input.raw', { terminalId, data: '\r', at: Date.now() })
    },
  }
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()!
    await cleanup()
  }
})

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 8_000, intervalMs = 20, message = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out waiting for ${message}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('AmplifierSessionLocator', () => {
  it('exports the plan §5 window constant', () => {
    expect(AMPLIFIER_DIR_APPEAR_WINDOW_MS).toBe(2_000)
  })

  it('binds two same-cwd terminals prompted in inverted spawn order via Enter-correlation (E8)', async () => {
    const h = await createHarness()
    h.arm('t1')
    h.arm('t2')
    await h.locator.whenReady()

    // Second-spawned terminal is prompted FIRST.
    h.submit('t2')
    await h.writeSessionDir('sess-b')
    await waitFor(() => h.located.length === 1, { message: 't2 located' })
    expect(h.located[0]).toMatchObject({ terminalId: 't2', sessionId: 'sess-b' })
    expect(h.located[0].eventsPath).toBe(
      path.join(h.home, 'projects', 'slug', 'sessions', 'sess-b', 'events.jsonl'),
    )
    // Simulate the controller bind completing (locator unregisters on bind).
    h.registry.emit('terminal.session.bound', {
      terminalId: 't2',
      provider: 'amplifier',
      sessionId: 'sess-b',
      reason: 'association',
    })
    await waitFor(() => h.locator.armedCount() === 1, { message: 't2 disarmed' })

    // First-spawned terminal prompts second.
    h.submit('t1')
    await h.writeSessionDir('sess-a')
    await waitFor(() => h.located.length === 2, { message: 't1 located' })
    expect(h.located[1]).toMatchObject({ terminalId: 't1', sessionId: 'sess-a' })
  })

  it('never binds a never-prompted terminal, cleans its entry on exit, and stops the watcher when none are armed', async () => {
    const h = await createHarness()
    h.arm('t1')
    await h.locator.whenReady()
    expect(h.locator.armedCount()).toBe(1)
    expect(h.locator.isWatching()).toBe(true)

    h.registry.emit('terminal.exit', { terminalId: 't1' })
    expect(h.locator.armedCount()).toBe(0)
    await waitFor(() => !h.locator.isWatching(), { message: 'watcher stopped' })
    expect(h.located).toHaveLength(0)
  })

  it('does not arm resume terminals', async () => {
    const h = await createHarness()
    h.arm('t1', { resumeSessionId: 'existing-session' })
    expect(h.locator.armedCount()).toBe(0)
    expect(h.locator.isWatching()).toBe(false)
  })

  it('refuses ambiguous double-first-prompt within the window and leaves both terminals to the slow path', async () => {
    const h = await createHarness({ windowMs: 1_000 })
    h.arm('t1')
    h.arm('t2')
    await h.locator.whenReady()

    h.submit('t1')
    h.submit('t2')
    await h.writeSessionDir('sess-a')
    await h.writeSessionDir('sess-b')

    await waitFor(
      () => h.warn.mock.calls.some(([payload]) => payload?.event === 'amplifier_locator_ambiguous'),
      { message: 'ambiguity warning' },
    )
    // Deterministic: both windows have provably resolved — no bind happened.
    await waitFor(
      () => windowResolved(h, 't1') && windowResolved(h, 't2'),
      { message: 'both windows resolved' },
    )
    expect(h.located).toHaveLength(0)
    // Both stay armed — the coordinator slow-path remains eligible.
    expect(h.locator.armedCount()).toBe(2)
  })

  it('ignores underscore-named dirs and session:start records with parent_id', async () => {
    const h = await createHarness()
    h.arm('t1')
    await h.locator.whenReady()

    h.submit('t1')
    await h.writeSessionDir('sub_agent-dir')
    await h.writeSessionDir('parented-dir', { parentId: 'parent-1' })
    await h.writeSessionDir('good-dir')

    await waitFor(() => h.located.length === 1, { message: 'good dir located' })
    expect(h.located[0]).toMatchObject({ terminalId: 't1', sessionId: 'good-dir' })
  })

  it('rejects candidates whose session:config cwd does not match the terminal cwd', async () => {
    const h = await createHarness({ windowMs: 300 })
    h.arm('t1')
    await h.locator.whenReady()

    h.submit('t1')
    await h.writeSessionDir('other-cwd-dir', { cwd: '/somewhere/else/entirely' })

    // Deterministic: wait for the window to provably resolve, then assert.
    await waitFor(() => windowResolved(h, 't1'), { message: 'window resolved' })
    expect(h.located).toHaveLength(0)
    // Zero candidates: the locator keeps watching (E5 empty-Enter semantics).
    expect(h.locator.armedCount()).toBe(1)
  })

  it('still correlates when events.jsonl appears after the dir (even past window close)', async () => {
    const h = await createHarness({ windowMs: 250, probeTimeoutMs: 3_000 })
    h.arm('t1')
    await h.locator.whenReady()

    h.submit('t1')
    const dir = await h.writeSessionDir('late-events-dir', { omitEvents: true })
    // File lands after the correlation window has already closed.
    await sleep(450)
    await fsp.writeFile(
      path.join(dir, 'events.jsonl'),
      eventsJsonl({ sessionId: 'late-events-dir', cwd: h.cwd }),
      'utf8',
    )

    await waitFor(() => h.located.length === 1, { message: 'late events located' })
    expect(h.located[0]).toMatchObject({ terminalId: 't1', sessionId: 'late-events-dir' })
  })

  it('excludes dirs from the pre-spawn snapshot', async () => {
    const h = await createHarness()
    // Pre-existing session dir with a matching cwd: must never be a candidate.
    await h.writeSessionDir('old-dir')

    h.arm('t1')
    await h.locator.whenReady()
    h.submit('t1')
    await h.writeSessionDir('fresh-dir')

    await waitFor(() => h.located.length === 1, { message: 'fresh dir located' })
    expect(h.located[0]).toMatchObject({ terminalId: 't1', sessionId: 'fresh-dir' })
    expect(h.warn.mock.calls.some(([payload]) => payload?.event === 'amplifier_locator_ambiguous')).toBe(false)
  })

  it('creates and watches projects/ when it does not exist yet (never an ancestor)', async () => {
    const h = await createHarness({ createProjectsDir: false })
    h.arm('t1')
    await h.locator.whenReady()

    // Finding A: arming pre-creates projects/ and watches exactly it.
    const projectsDir = path.join(h.home, 'projects')
    expect(fs.existsSync(projectsDir)).toBe(true)
    expect(h.watchPaths).toEqual([path.resolve(projectsDir)])

    h.submit('t1')
    await h.writeSessionDir('first-ever-dir')

    await waitFor(() => h.located.length === 1, { message: 'first-ever dir located' })
    expect(h.located[0]).toMatchObject({ terminalId: 't1', sessionId: 'first-ever-dir' })
  })

  it('arming with amplifierHome entirely absent creates projects/ and never watches outside amplifierHome', async () => {
    // Finding A regression: the old nearest-existing-ancestor walk escaped to
    // $HOME (or /) when the amplifier home was missing, recursively watching
    // the whole home tree (inotify exhaustion).
    const h = await createHarness({ removeHome: true })
    h.arm('t1')
    await h.locator.whenReady()

    const projectsDir = path.resolve(path.join(h.home, 'projects'))
    expect(fs.existsSync(projectsDir)).toBe(true)
    expect(h.watchPaths.length).toBeGreaterThan(0)
    for (const watchPath of h.watchPaths) {
      expect(watchPath).toBe(projectsDir)
      expect(path.resolve(watchPath).startsWith(path.resolve(h.home) + path.sep)).toBe(true)
    }

    // The watch is functional: first-ever session dir still correlates.
    h.submit('t1')
    await h.writeSessionDir('first-ever-dir')
    await waitFor(() => h.located.length === 1, { message: 'first-ever dir located' })
    expect(h.located[0]).toMatchObject({ terminalId: 't1', sessionId: 'first-ever-dir' })
  })

  it('a persistent watcher error self-disables the locator with a single warn', async () => {
    const emitters: Array<{ emitter: EventEmitter; closed: boolean }> = []
    const h = await createHarness({
      watchImpl: () => {
        const entry = { emitter: new EventEmitter(), closed: false }
        emitters.push(entry)
        setImmediate(() => entry.emitter.emit('ready'))
        return {
          on: (event: string, handler: (...args: any[]) => void) => entry.emitter.on(event, handler),
          close: async () => {
            entry.closed = true
          },
        }
      },
    })
    h.arm('t1')
    await h.locator.whenReady()
    expect(h.locator.isWatching()).toBe(true)

    emitters[0].emitter.emit('error', new Error('EMFILE: inotify exhausted'))
    emitters[0].emitter.emit('error', new Error('EMFILE: inotify exhausted'))

    const watchErrorWarns = h.warn.mock.calls.filter(
      ([payload]) => payload?.event === 'amplifier_locator_watch_error',
    )
    expect(watchErrorWarns).toHaveLength(1)
    expect(h.locator.isWatching()).toBe(false)
    await waitFor(() => emitters[0].closed, { message: 'failed watcher closed' })

    // Sticky: arming more terminals never re-creates a watcher.
    h.arm('t2')
    expect(h.locator.isWatching()).toBe(false)
    expect(emitters).toHaveLength(1)
  })

  it('never correlates a dir created well before the Enter press (pre-epsilon bound, finding F)', async () => {
    const h = await createHarness()
    h.arm('t1')
    await h.locator.whenReady()

    // A FOREIGN session dir appears with a matching cwd (e.g. another launcher
    // in the same cwd) — observed by the watcher well before any Enter here.
    const dir = await h.writeSessionDir('foreign-dir')
    await waitFor(() => hasDiscovery(h, dir), { message: 'foreign dir discovered' })
    // Age the discovery past the jitter allowance, deterministically.
    await sleep(AMPLIFIER_DIR_PRE_EPSILON_MS + 150)

    h.submit('t1')
    await waitFor(() => windowResolved(h, 't1'), { message: 'window resolved' })
    expect(h.located).toHaveLength(0)
    expect(h.locator.armedCount()).toBe(1)
  })

  it('still correlates a dir observed marginally before the Enter (jitter tolerance)', async () => {
    const h = await createHarness()
    h.arm('t1')
    await h.locator.whenReady()

    const dir = await h.writeSessionDir('jitter-dir')
    await waitFor(() => hasDiscovery(h, dir), { message: 'dir discovered' })
    // ~100ms of observed-before-submit skew: within the 250ms pre-epsilon.
    await sleep(100)
    h.submit('t1')

    await waitFor(() => h.located.length === 1, { message: 'jitter dir located' })
    expect(h.located[0]).toMatchObject({ terminalId: 't1', sessionId: 'jitter-dir' })
  })

  it('arms running unbound amplifier terminals that existed before construction (finding H)', async () => {
    const h = await createHarness({
      preexistingTerminals: [
        { terminalId: 't-pre' },
        { terminalId: 't-pre-resume', resumeSessionId: 'existing-session' },
      ],
    })
    // Constructor sweep armed the unbound terminal only (resume never arms).
    expect(h.locator.armedCount()).toBe(1)
    expect(h.locator.isWatching()).toBe(true)
    await h.locator.whenReady()

    h.submit('t-pre')
    await h.writeSessionDir('pre-existing-terminal-dir')
    await waitFor(() => h.located.length === 1, { message: 'pre-existing terminal located' })
    expect(h.located[0]).toMatchObject({ terminalId: 't-pre', sessionId: 'pre-existing-terminal-dir' })
  })

  it('re-probes a probe_timeout-rejected discovery when events.jsonl changes later (finding I)', async () => {
    // Short probe deadline, long window: the session's config record lands
    // AFTER the probe hard-deadline but while the window is still open.
    const h = await createHarness({ windowMs: 3_000, probeTimeoutMs: 100 })
    h.arm('t1')
    await h.locator.whenReady()

    h.submit('t1')
    const dir = await h.writeSessionDir('slow-config-dir', { omitEvents: true })
    await waitFor(
      () => discoveryState(h, dir) === 'rejected',
      { message: 'probe_timeout rejection' },
    )

    // events.jsonl finally lands: the rejection must not be permanent.
    await fsp.writeFile(
      path.join(dir, 'events.jsonl'),
      eventsJsonl({ sessionId: 'slow-config-dir', cwd: h.cwd }),
      'utf8',
    )
    await waitFor(() => h.located.length === 1, { message: 'slow-config dir located' })
    expect(h.located[0]).toMatchObject({ terminalId: 't1', sessionId: 'slow-config-dir' })
  })

  it('rescans projects/*/sessions/* at window close when the watcher announced nothing (finding J)', async () => {
    // Inert watcher: simulates a dir created during chokidar's initial scan
    // (swallowed by ignoreInitial and never announced).
    const h = await createHarness({ watchImpl: inertWatchFactory() })
    h.arm('t1')
    await h.locator.whenReady()

    h.submit('t1')
    await h.writeSessionDir('unannounced-dir')

    // Window close performs the one-shot readdir snapshot-diff, anchors the
    // dir at its fs.stat birth/mtime (after the Enter here), and feeds it
    // through the normal discovery path (probe + cwd confirm).
    await waitFor(() => h.located.length === 1, { message: 'unannounced dir located via rescan' })
    expect(h.located[0]).toMatchObject({ terminalId: 't1', sessionId: 'unannounced-dir' })
  })

  it('rescan never resurrects a dir born before the Enter press (N1: stat-anchored, pre-epsilon enforced)', async () => {
    // Re-verification finding N1: anchoring rescanned dirs at window.openedAt
    // auto-satisfied the eligibility bounds, defeating finding F's pre-Enter
    // epsilon — an alien same-cwd session dir created BEFORE the Enter got
    // bound (the OpenCode-RCA wrong-binding class). The rescan must anchor at
    // the dir's fs.stat birthtime/mtime instead and reject pre-Enter dirs.
    const h = await createHarness({ watchImpl: inertWatchFactory() })
    h.arm('t1')
    await h.locator.whenReady()

    // Alien same-cwd session dir born ~400ms BEFORE the Enter; the inert
    // watcher never announces it, so only the rescan could ever see it.
    await h.writeSessionDir('alien-dir')
    await sleep(AMPLIFIER_DIR_PRE_EPSILON_MS + 150)

    h.submit('t1')
    await waitFor(() => windowResolved(h, 't1'), { message: 'window resolved' })
    expect(h.located).toHaveLength(0)
    // Still armed: the coordinator slow-path remains eligible.
    expect(h.locator.armedCount()).toBe(1)
  })

  it('dispose closes the watcher and clears armed terminals', async () => {
    const h = await createHarness()
    h.arm('t1')
    await h.locator.whenReady()
    expect(h.locator.isWatching()).toBe(true)

    await h.locator.dispose()
    expect(h.locator.armedCount()).toBe(0)
    expect(h.locator.isWatching()).toBe(false)

    // Registered handlers are detached: further registry events are ignored.
    h.arm('t2')
    expect(h.locator.armedCount()).toBe(0)
  })
})
