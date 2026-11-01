// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import plugin, {
  createEmitter,
  createObservationEmitter,
  emitHello,
  extractSessionId,
  hasAdoptionExpectation,
  type EmitterDeps,
} from '../../../extensions/opencode/freshell-rebind-plugin.js'
import { seedManagedOpenCodeSource } from '../../e2e-browser/fixtures/managed-opencode-source.js'

describe('extractSessionId', () => {
  it('accepts direct sessionID / session_id / sessionId keys', () => {
    expect(extractSessionId({ sessionID: 'ses_abc123' })).toBe('ses_abc123')
    expect(extractSessionId({ session_id: 'ses_abc123' })).toBe('ses_abc123')
    expect(extractSessionId({ sessionId: 'ses_abc123' })).toBe('ses_abc123')
  })

  it('accepts the TUI route shape { name: "session", params: { sessionID } }', () => {
    expect(
      extractSessionId({ name: 'session', params: { sessionID: 'ses_route1' } }),
    ).toBe('ses_route1')
  })

  it('rejects non-ses_ ids, empty, and junk shapes', () => {
    expect(extractSessionId({ sessionID: 'not-a-session' })).toBeNull()
    expect(extractSessionId({ sessionID: '' })).toBeNull()
    expect(extractSessionId({ sessionID: 'ses_' })).toBeNull()
    expect(extractSessionId(null)).toBeNull()
    expect(extractSessionId(42)).toBeNull()
    expect(extractSessionId('ses_bare-string-ok')).toBeNull() // ses_ + non-alnum rejected
    expect(extractSessionId('ses_barestringok')).toBe('ses_barestringok')
  })
})

describe('emitHello', () => {
  const writes: Array<{ dir: string; name: string; body: string }> = []
  const deps = (env: EmitterDeps['env']): EmitterDeps => ({
    env,
    writeFile: (dir, name, body) => writes.push({ dir, name, body }),
    now: () => 1_700_000_000_000,
  })
  beforeEach(() => writes.splice(0))

  it('writes a hello signal named <terminalId>__<nonce> into the opencode signal dir', () => {
    emitHello(deps({ HOME: '/home/u', FRESHELL_TERMINAL_ID: 'term-1' }))
    expect(writes).toHaveLength(1)
    expect(writes[0].dir).toBe('/home/u/.freshell/session-signals/opencode')
    expect(writes[0].name).toMatch(/^term-1__\d{14}-\d{6}-\d+$/)
    expect(writes[0].name.split('__')).toHaveLength(2) // nonce never contains the __ delimiter
    expect(JSON.parse(writes[0].body)).toEqual({
      hello: true,
      source: 'opencode-tui-plugin',
    })
  })

  it('never writes without a home dir or FRESHELL_TERMINAL_ID', () => {
    emitHello(deps({ FRESHELL_TERMINAL_ID: 'term-1' }))
    emitHello(deps({ HOME: '/home/u' }))
    expect(writes).toHaveLength(0)
  })

  it('swallows writer exceptions (never surfaces into the TUI)', () => {
    expect(() =>
      emitHello({
        env: { HOME: '/home/u', FRESHELL_TERMINAL_ID: 'term-1' },
        writeFile: () => {
          throw new Error('disk full')
        },
      }),
    ).not.toThrow()
  })
})

describe('createEmitter', () => {
  const writes: Array<{ dir: string; name: string; body: string }> = []
  const deps = (env: EmitterDeps['env']): EmitterDeps => ({
    env,
    writeFile: (dir, name, body) => writes.push({ dir, name, body }),
    now: () => 1_700_000_000_000,
  })
  beforeEach(() => writes.splice(0))

  it('writes <terminalId>__<nonce> with a session_id body into the opencode signal dir', () => {
    const emit = createEmitter(deps({ HOME: '/home/u', FRESHELL_TERMINAL_ID: 'term-1' }))
    emit({ sessionID: 'ses_aaa1' })
    expect(writes).toHaveLength(1)
    expect(writes[0].dir).toBe('/home/u/.freshell/session-signals/opencode')
    expect(writes[0].name).toMatch(/^term-1__\d{14}-\d{6}-\d+$/)
    expect(writes[0].name.split('__')).toHaveLength(2) // nonce never contains the __ delimiter
    expect(JSON.parse(writes[0].body)).toEqual({
      session_id: 'ses_aaa1',
      source: 'opencode-tui-plugin',
    })
  })

  it('dedupes repeats of the same id but emits again on change (A -> A -> B -> A)', () => {
    const emit = createEmitter(deps({ HOME: '/h', FRESHELL_TERMINAL_ID: 't' }))
    emit({ sessionID: 'ses_a' })
    emit({ sessionID: 'ses_a' })
    emit({ sessionID: 'ses_b' })
    emit({ sessionID: 'ses_a' })
    expect(writes.map((w) => JSON.parse(w.body).session_id)).toEqual(['ses_a', 'ses_b', 'ses_a'])
  })

  it('mirrors the consumer home precedence: USERPROFILE wins on win32, HOME elsewhere', () => {
    // The Rust consumer (OpencodeSignalWatcher::default_root) is cfg-gated:
    // USERPROFILE only on Windows, HOME otherwise. The producer must agree,
    // or a git-bash/MSYS Windows user with HOME set would emit signals into
    // a directory the server never sweeps.
    const both = { HOME: '/msys/home/u', USERPROFILE: 'C:\\Users\\u', FRESHELL_TERMINAL_ID: 't' }
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      createEmitter(deps(both))({ sessionID: 'ses_win1' })
      expect(writes).toHaveLength(1)
      expect(writes[0].dir.startsWith('C:\\Users\\u')).toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform })
    }
    writes.splice(0)
    createEmitter(deps(both))({ sessionID: 'ses_nix1' })
    expect(writes).toHaveLength(1)
    expect(writes[0].dir).toBe('/msys/home/u/.freshell/session-signals/opencode')
  })

  it('never writes without FRESHELL_TERMINAL_ID or a home dir', () => {
    createEmitter(deps({ HOME: '/h' }))({ sessionID: 'ses_a' })
    createEmitter(deps({ FRESHELL_TERMINAL_ID: 't' }))({ sessionID: 'ses_a' })
    expect(writes).toHaveLength(0)
  })

  it('swallows writer exceptions (losing a signal degrades to no-rebind)', () => {
    const emit = createEmitter({
      env: { HOME: '/h', FRESHELL_TERMINAL_ID: 't' },
      writeFile: () => {
        throw new Error('disk full')
      },
    })
    expect(() => emit({ sessionID: 'ses_a' })).not.toThrow()
  })
})

describe('createObservationEmitter', () => {
  const writes: Array<{ dir: string; name: string; body: string }> = []
  const rootSessionId = 'ses_exactroot1'
  const tailMessageId = 'msg_exacttail1'
  const evidenceGeneration = 'a'.repeat(64)
  const incarnationId = 'incarnation-9'
  const launchNonce = 'launch-abc123'

  const deps = (overrides: Record<string, string | undefined> = {}): EmitterDeps => ({
    env: {
      HOME: '/home/u',
      FRESHELL_TERMINAL_ID: 'term-managed',
      FRESHELL_OPENCODE_ADOPTION_ROOT_SESSION_ID: rootSessionId,
      FRESHELL_OPENCODE_ADOPTION_TAIL_MESSAGE_ID: tailMessageId,
      FRESHELL_OPENCODE_ADOPTION_EXPECTED_EMPTY: 'false',
      FRESHELL_OPENCODE_ADOPTION_EVIDENCE_GENERATION: evidenceGeneration,
      FRESHELL_OPENCODE_ADOPTION_INCARNATION_ID: incarnationId,
      FRESHELL_OPENCODE_ADOPTION_LAUNCH_NONCE: launchNonce,
      ...overrides,
    },
    writeFile: (dir, name, body) => writes.push({ dir, name, body }),
    now: () => 1_700_000_000_000,
    onRefusal: () => {},
  })

  const makeApi = (options: {
    sessionId?: string
    routeSessionId?: string
    stateReady?: boolean
    session?: Record<string, unknown> | undefined
    tuiMessages?: unknown
    nativeMessages?: unknown
    nativeRead?: (parameters: { sessionID: string; limit?: number }, options?: { throwOnError: true }) => Promise<unknown>
  } = {}) => {
    const sessionId = options.sessionId ?? rootSessionId
    const session = options.session === undefined
      ? { id: sessionId, parentID: undefined }
      : options.session
    const tuiMessages = options.tuiMessages ?? [{ id: tailMessageId, sessionID: sessionId, text: 'private user content' }]
    const nativeMessages = options.nativeMessages ?? [{ info: { id: tailMessageId, sessionID: sessionId }, parts: [{ id: 'prt_tail1', messageID: tailMessageId, sessionID: sessionId, text: 'private user content' }] }]
    return {
      route: { current: { name: 'session', params: { sessionID: options.routeSessionId ?? sessionId } } },
      state: {
        ready: options.stateReady ?? true,
        part: (id: string) => nativeMessages.flatMap((row: any) => row.info?.id === id ? row.parts : []),
        session: {
          get: (id: string) => id === sessionId ? session : undefined,
          messages: (id: string) => id === sessionId ? tuiMessages : [],
        },
      },
      client: {
        session: {
          get: async () => ({ data: session }),
          messages: options.nativeRead ?? (async () => ({ data: nativeMessages })),
        },
        v2: {
          session: {
            messages:
              options.nativeRead ??
              (async () => ({ data: { data: nativeMessages } })),
          },
        },
      },
    }
  }

  beforeEach(() => writes.splice(0))

  it('retains bounded body-free read and publication phases across a current expectation rotation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'opencode-current-poll-'))
    const selected = deps()
    const diagnosticRoot = join(directory, '.freshell/session-signals/opencode-adoption-diagnostics')
    const diagnostic = (stage: string) => JSON.parse(readFileSync(join(diagnosticRoot, `term-managed.${stage}.json`), 'utf8'))
    let descriptor: string | null = null
    let settle: (value: unknown) => void = () => {}
    const api = makeApi({ nativeRead: () => new Promise(resolve => { settle = resolve }) })
    const emit = createObservationEmitter({ ...selected, env: { ...selected.env, HOME: directory },
      readExpectation: () => descriptor })
    try {
      const first = emit(api)
      await vi.waitFor(() => expect(diagnostic('native_read_pending').inFlight).toBe(true))
      await emit(api)
      expect(diagnostic('in_flight').launchNonce).toBe(launchNonce)
      settle({ data: [{ info: { id: tailMessageId, sessionID: rootSessionId }, parts: [] }] })
      await first
      expect(diagnostic('publication_succeeded').launchNonce).toBe(launchNonce)
      descriptor = JSON.stringify({ terminal_id: 'term-managed', root_session_id: rootSessionId,
        incarnation_id: incarnationId, launch_nonce: 'rotated-current-nonce', evidence_generation: 'b'.repeat(64),
        root_tail: { state: 'message', data: { message_id: tailMessageId } } })
      api.client.session.messages = async () => ({ data: [{ info: { id: tailMessageId, sessionID: rootSessionId }, parts: [] }] })
      await emit(api)
      expect(writes.map(row => JSON.parse(row.body).adoption_observation.launch_nonce)).toEqual([
        launchNonce, 'rotated-current-nonce',
      ])
      expect(diagnostic('expectation_read').launchNonce).toBe('rotated-current-nonce')
      expect(diagnostic('publication_succeeded')).toMatchObject({ evidenceGeneration: 'b'.repeat(64),
        event: 'runtime.opencode.native_observation_progress', severity: 'info', inFlight: true })
      await emit(api)
      expect(writes).toHaveLength(2)
      expect(diagnostic('duplicate').launchNonce).toBe('rotated-current-nonce')
      for (const stage of ['expectation_read', 'native_read_pending', 'native_read_settled', 'publication_succeeded', 'in_flight', 'duplicate']) {
        expect(JSON.stringify(diagnostic(stage))).not.toContain('private')
        expect(diagnostic(stage).adoption_observation).toBeUndefined()
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('keeps diagnostic filesystem failure inert for actual native receipt publication', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'opencode-poll-storage-'))
    const selected = deps()
    try {
      const parent = join(directory, '.freshell/session-signals')
      mkdirSync(parent, { recursive: true })
      writeFileSync(join(parent, 'opencode-adoption-diagnostics'), 'owned obstruction')
      const emit = createObservationEmitter({ ...selected, env: { ...selected.env, HOME: directory } })
      await expect(emit(makeApi())).resolves.toBeUndefined()
      expect(writes).toHaveLength(1)
      expect(JSON.parse(writes[0].body).adoption_observation.launch_nonce).toBe(launchNonce)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it.each(['get', 'messages'])('distinguishes an unavailable TUI session %s API from an unloaded root', async (method) => {
    const refusal = vi.fn()
    const api = makeApi() as any
    delete api.state.session[method]
    await createObservationEmitter({ ...deps(), onRefusal: refusal })(api)
    expect(refusal).toHaveBeenCalledOnce()
    expect(refusal.mock.calls[0][0]).toMatchObject({
      reason: 'tui_session_api_unavailable', nativeSessionId: rootSessionId,
      incarnationId, launchNonce, evidenceGeneration,
    })
    expect(writes).toHaveLength(0)
    expect(JSON.stringify(refusal.mock.calls)).not.toContain('private')
  })

  it.each(['empty', 'different-tail'])('distinguishes native V1 history %s from missing TUI hydration', async (fault) => {
    const refusal = vi.fn()
    const api = makeApi({ nativeMessages: fault === 'empty' ? [] : [
      { info: { id: 'msg_different1', sessionID: rootSessionId }, parts: [] },
    ] })
    await createObservationEmitter({ ...deps(), onRefusal: refusal })(api)
    expect(refusal).toHaveBeenCalledOnce()
    expect(refusal.mock.calls[0][0]).toMatchObject({ reason: 'native_tail_mismatch',
      nativeSessionId: rootSessionId, incarnationId, launchNonce, evidenceGeneration })
    expect(writes).toHaveLength(0)
    expect(JSON.stringify(refusal.mock.calls)).not.toContain('private')
  })

  it.each(['native-empty', 'tui-empty', 'tui-different-tail'])('records body-free active history counts for the %s refusal', async fault => {
    const refusal = vi.fn()
    const api = makeApi({
      ...(fault === 'native-empty' ? { nativeMessages: [] } : {}),
      ...(fault === 'tui-empty' ? { tuiMessages: [] } : {}),
      ...(fault === 'tui-different-tail' ? { tuiMessages: [{ id: 'msg_other1', sessionID: rootSessionId, text: 'private transcript' }] } : {}),
    })
    await createObservationEmitter({ ...deps(), onRefusal: refusal })(api)
    expect(refusal).toHaveBeenCalledOnce()
    expect(refusal.mock.calls[0][0]).toMatchObject({
      reason: fault === 'native-empty' ? 'native_tail_mismatch' : 'tail_not_hydrated',
      nativeActiveMessageCount: fault === 'native-empty' ? 0 : 1,
      tuiActiveMessageCount: fault === 'tui-empty' ? 0 : 1,
    })
    expect(JSON.stringify(refusal.mock.calls)).not.toContain('private')
    expect(writes).toHaveLength(0)
  })
  it.each(['empty-page', 'hydrated-page', 'page-load-failure'])('distinguishes the actual TUI limit100 read from empty synced state (%s)', async fault => {
    const refusal = vi.fn()
    const api = makeApi({ tuiMessages: [] })
    const messages = [{ info: { id: tailMessageId, sessionID: rootSessionId }, parts: [] }]
    const nativeRead = vi.fn(async (parameters: { sessionID: string; limit?: number }) => {
      if (parameters.limit === 100) {
        if (fault === 'page-load-failure') throw new Error('private native page failure')
        return { data: fault === 'empty-page' ? [] : messages }
      }
      return { data: messages }
    })
    api.client.session.messages = nativeRead
    await createObservationEmitter({ ...deps(), onRefusal: refusal })(api)
    expect(refusal).toHaveBeenCalledOnce()
    expect(refusal.mock.calls[0][0]).toMatchObject({ reason: 'tail_not_hydrated', nativeActiveMessageCount: 1,
      tuiActiveMessageCount: 0, nativeTuiPageMessageCount: fault === 'page-load-failure' ? null : fault === 'empty-page' ? 0 : 1 })
    expect(nativeRead.mock.calls.map(call => call[0])).toEqual([{ sessionID: rootSessionId }, { sessionID: rootSessionId, limit: 100 }])
    expect(JSON.stringify(refusal.mock.calls)).not.toContain('private')
    expect(writes).toHaveLength(0)
  })
  it('keeps a disposed pending TUI page diagnostic from publishing a late identity or refusal', async () => {
    const signal = new AbortController(), refusal = vi.fn()
    let release: (value: unknown) => void = () => {}
    const pending = new Promise(resolve => { release = resolve })
    const api = makeApi({ tuiMessages: [], nativeRead: async parameters => parameters.limit === 100 ? pending : {
      data: [{ info: { id: tailMessageId, sessionID: rootSessionId }, parts: [] }],
    } })
    const nativeRead = vi.spyOn(api.client.session, 'messages')
    const observing = createObservationEmitter({ ...deps(), signal: signal.signal, onRefusal: refusal })(api)
    await vi.waitFor(() => expect(nativeRead).toHaveBeenCalledTimes(2))
    signal.abort(); release({ data: [] }); await observing
    expect(writes).toHaveLength(0); expect(refusal).not.toHaveBeenCalled()
  })
  it.each(['not-ready', 'root-load', 'history-load', 'tail', 'parts'])('records a bounded body-free current native refusal (%s)', async (fault) => {
    const refusal = vi.fn()
    const emit = createObservationEmitter({ ...deps(), onRefusal: refusal })
    const api = makeApi() as any
    if (fault === 'not-ready') api.state.ready = false
    if (fault === 'root-load') api.client.session.get = async () => { throw new Error('private provider root detail') }
    if (fault === 'history-load') api.client.session.messages = async () => { throw new Error('private transcript load detail') }
    if (fault === 'tail') api.state.session.messages = () => []
    if (fault === 'parts') api.state.part = () => []
    await emit(api); await emit(api)
    expect(refusal).toHaveBeenCalledOnce()
    expect(refusal.mock.calls[0][0]).toMatchObject({ severity: 'warning', event: 'runtime.opencode.native_observation_refused',
      terminalId: 'term-managed', nativeSessionId: rootSessionId, incarnationId, launchNonce,
      evidenceGeneration, reason: { 'not-ready': 'tui_not_ready', 'root-load': 'native_root_load_failed',
        'history-load': 'native_history_load_failed', tail: 'tail_not_hydrated', parts: 'parts_not_hydrated' }[fault] })
    expect(JSON.stringify(refusal.mock.calls)).not.toContain('private')
    expect(writes.every(row => JSON.parse(row.body).adoption_observation.messages_read === 'failed')).toBe(true)
  })
  it('persists the default native refusal separately from identity receipts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'opencode-native-refusal-'))
    const selected = deps()
    try {
      const emit = createObservationEmitter({ ...selected, env: { ...selected.env, HOME: directory }, onRefusal: undefined })
      await emit(makeApi({ stateReady: false }))
      const diagnostic = JSON.parse(readFileSync(join(directory, '.freshell/session-signals/opencode-adoption-diagnostics/term-managed.json'), 'utf8'))
      expect(diagnostic.reason).toBe('tui_not_ready'); expect(diagnostic.launchNonce).toBe(launchNonce)
      expect(diagnostic.adoption_observation).toBeUndefined(); expect(writes).toHaveLength(0)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('retries failed diagnostic storage and keeps native input unqualified', async () => {
    const refusal = vi.fn(() => { throw new Error('private filesystem error') })
    const emit = createObservationEmitter({ ...deps(), onRefusal: refusal })
    await expect(emit(makeApi({ stateReady: false }))).resolves.toBeUndefined()
    await expect(emit(makeApi({ stateReady: false }))).resolves.toBeUndefined()
    expect(refusal).toHaveBeenCalledTimes(2); expect(writes).toHaveLength(0)
  })
  it('reports a native read failure without awaiting a different stalled read', async () => {
    const refusal = vi.fn(), api = makeApi() as any
    api.client.session.get = async () => { throw new Error('private root error') }
    api.client.session.messages = () => new Promise(() => {})
    await createObservationEmitter({ ...deps(), onRefusal: refusal })(api)
    expect(refusal.mock.calls[0][0].reason).toBe('native_root_load_failed')
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0].body).adoption_observation.messages_read).toBe('failed')
  })

  it('emits only an exact hydrated root and current tail, with body-free launch bindings', async () => {
    const emit = createObservationEmitter(deps())
    await emit(makeApi())

    expect(writes).toHaveLength(1)
    expect(writes[0].dir).toBe('/home/u/.freshell/session-signals/opencode-adoption')
    expect(writes[0].name).toMatch(/^term-managed__\d{14}-\d{6}-\d+$/)
    const body = JSON.parse(writes[0].body)
    expect(body.session_id).toBe(rootSessionId)
    expect(body.adoption_observation).toEqual({
      terminal_id: 'term-managed',
      root_session_id: rootSessionId,
      tail_message_id: tailMessageId,
      evidence_generation: evidenceGeneration,
      incarnation_id: incarnationId,
      launch_nonce: launchNonce,
      hydrated: true,
      messages_read: 'success',
    })
    expect(writes[0].body).not.toContain('private user content')
  })

  it.each(['route-change', 'readiness-loss', 'dispose'] as const)(
    'withdraws an already adopted root on %s and republishes only current hydration', async edge => {
      const abort = new AbortController()
      const api = makeApi()
      const emit = createObservationEmitter({ ...deps(), signal: abort.signal })
      await emit(api)
      expect(writes).toHaveLength(1)
      if (edge === 'route-change') api.route.current.params.sessionID = 'ses_otherroot1'
      if (edge === 'readiness-loss') api.state.ready = false
      if (edge === 'dispose') abort.abort()
      await emit(api)
      expect(writes).toHaveLength(2)
      expect(JSON.parse(writes[1].body).adoption_observation).toMatchObject({
        root_session_id: rootSessionId, incarnation_id: incarnationId, launch_nonce: launchNonce,
        evidence_generation: evidenceGeneration, hydrated: false, messages_read: 'failed',
      })
      await emit(api)
      expect(writes).toHaveLength(2)
      if (edge === 'dispose') return
      api.route.current.params.sessionID = rootSessionId
      api.state.ready = true
      await emit(api)
      expect(writes).toHaveLength(3)
      expect(JSON.parse(writes[2].body).adoption_observation.hydrated).toBe(true)
      abort.abort()
    },
  )

  it('withdraws an adopted root while a same-root read is pending without publishing its late result', async () => {
    const api = makeApi()
    const emit = createObservationEmitter(deps())
    await emit(api)
    let finish!: (value: unknown) => void
    api.client.session.messages = () => new Promise(resolve => { finish = resolve })
    const pending = emit(api)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    api.route.current.params.sessionID = 'ses_otherroot1'
    await emit(api)
    expect(writes).toHaveLength(2)
    expect(JSON.parse(writes[1].body).adoption_observation.hydrated).toBe(false)
    finish({ data: [{ info: { id: tailMessageId, sessionID: rootSessionId }, parts: [] }] })
    await pending
    expect(writes).toHaveLength(2)
  })

  it('refuses V2 empty projections when the V1 root has active history', async () => {
    const emit = createObservationEmitter(deps({
      FRESHELL_OPENCODE_ADOPTION_TAIL_MESSAGE_ID: undefined,
      FRESHELL_OPENCODE_ADOPTION_EXPECTED_EMPTY: 'true',
    }))
    const api = makeApi({ tuiMessages: [], nativeMessages: [] }) as any
    api.client.session = {
      get: async () => ({ data: { id: rootSessionId, parentID: null } }),
      messages: async () => ({ data: [{ info: { id: tailMessageId, sessionID: rootSessionId }, parts: [] }] }),
    }
    await emit(api)
    expect(writes.some((row) => JSON.parse(row.body).adoption_observation.messages_read === 'empty_confirmed')).toBe(false)
  })

  it('observes the active V1 tail before a saved full-message revert', async () => {
    const earlier = 'msg_before1'
    const reverted = 'msg_reverted1'
    const emit = createObservationEmitter(deps({ FRESHELL_OPENCODE_ADOPTION_TAIL_MESSAGE_ID: earlier }))
    const session = { id: rootSessionId, parentID: null, revert: { messageID: reverted } }
    const api = makeApi({ session, tuiMessages: [
      { id: earlier, sessionID: rootSessionId }, { id: reverted, sessionID: rootSessionId },
    ] }) as any
    api.client.session = {
      get: async () => ({ data: session }),
      messages: async () => ({ data: [earlier, reverted].map((id) => ({ info: { id, sessionID: rootSessionId }, parts: [] })) }),
    }
    api.state.part = () => []
    await emit(api)
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0].body).adoption_observation).toMatchObject({ tail_message_id: earlier, messages_read: 'success' })
  })

  it('confirms active V1 empty history when all preserved messages are reverted', async () => {
    const session = { id: rootSessionId, parentID: null, revert: { messageID: tailMessageId } }
    const api = makeApi({ session }) as any
    const emit = createObservationEmitter(deps({ FRESHELL_OPENCODE_ADOPTION_EXPECTED_EMPTY: 'true',
      FRESHELL_OPENCODE_ADOPTION_TAIL_MESSAGE_ID: undefined }))
    await emit(api)
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0].body).adoption_observation.messages_read).toBe('empty_confirmed')
  })

  it('requires the active part-revert tail and actual hydrated preceding parts', async () => {
    const later = 'msg_later1'
    const session = { id: rootSessionId, parentID: null,
      revert: { messageID: tailMessageId, partID: 'prt_boundary1' } }
    const parts = [{ id: 'prt_active1' }, { id: 'prt_boundary1' }, { id: 'prt_after1' }]
    const api = makeApi({ session, tuiMessages: [{ id: tailMessageId, sessionID: rootSessionId },
      { id: later, sessionID: rootSessionId }], nativeMessages: [
      { info: { id: tailMessageId, sessionID: rootSessionId }, parts },
      { info: { id: later, sessionID: rootSessionId }, parts: [] },
    ] }) as any
    const emit = createObservationEmitter(deps())
    api.state.part = () => []
    await emit(api)
    expect(writes).toHaveLength(0)
    api.state.part = () => parts
    await emit(api)
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0].body).adoption_observation).toMatchObject({ tail_message_id: tailMessageId, messages_read: 'success' })
  })

  it('refuses global-ready and matching TUI tail after an actual V1 load error', async () => {
    await createObservationEmitter(deps())(makeApi({ nativeRead: async () => { throw new Error('load failed') } }))
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0].body).adoption_observation.messages_read).toBe('failed')
  })

  it('retries unchanged managed evidence after a failed publication and suppresses successful duplicates', async () => {
    const emitterDeps = deps()
    let attempts = 0
    emitterDeps.writeFile = (dir, name, body) => {
      attempts += 1
      if (attempts === 1) throw new Error('transient publication failure')
      writes.push({ dir, name, body })
    }
    const emit = createObservationEmitter(emitterDeps)
    const api = makeApi()

    await expect(emit(api)).resolves.toBeUndefined()
    expect(writes).toHaveLength(0)
    await emit(api)
    expect(attempts).toBe(2)
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0].body).adoption_observation.launch_nonce).toBe(launchNonce)
    await emit(api)
    expect(attempts).toBe(2)
    expect(writes).toHaveLength(1)
  })

  it('accepts the native tail generated by the managed OpenCode source fixture', async () => {
    const home = mkdtempSync(join(tmpdir(), 'freshell-managed-opencode-source-'))
    const databasePath = join(home, '.local/share/opencode/opencode.db')
    try {
      const source = seedManagedOpenCodeSource({
        repoRoot: process.cwd(),
        databasePath,
        workspace: home,
        nonce: '0123456789abcdef',
        messageCount: 2,
      })
      const db = new DatabaseSync(databasePath, { readOnly: true })
      try {
        const sessions = db.prepare('SELECT id, parent_id, workspace_id FROM session').all() as Array<{ id: string; parent_id: string | null; workspace_id: string | null }>
        expect(sessions.length).toBeGreaterThan(0)
        for (const row of sessions) expect(row.id).toMatch(/^ses_[A-Za-z0-9]{26}$/)
        for (const row of sessions) {
          if (row.parent_id !== null) expect(row.parent_id).toMatch(/^ses_[A-Za-z0-9]{26}$/)
          expect(row.workspace_id).toBeNull()
        }

        const projects = db.prepare('SELECT id FROM project').all() as Array<{ id: string }>
        expect(projects).toHaveLength(1)
        expect(projects[0].id).toMatch(/^[a-f0-9]{40}$/)
        const events = db.prepare('SELECT id, data FROM event').all() as Array<{ id: string; data: string }>
        expect(events).toHaveLength(1)
        for (const row of events) expect(row.id).toMatch(/^evt_[A-Za-z0-9]{26}$/)
        const eventInfo = (JSON.parse(events[0].data) as { info: { workspaceID?: unknown } }).info
        expect(eventInfo.workspaceID).toBeUndefined()

        const rows = db.prepare('SELECT id, data FROM message').all() as Array<{ id: string; data: string }>
        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) expect(row.id).toMatch(/^msg_[A-Za-z0-9]{26}$/)
        for (const row of rows) {
          const parentId = (JSON.parse(row.data) as { parentID?: unknown }).parentID
          if (parentId !== undefined) expect(parentId).toMatch(/^msg_[A-Za-z0-9]{26}$/)
        }

        const parts = db.prepare('SELECT id FROM part').all() as Array<{ id: string }>
        expect(parts.length).toBeGreaterThan(0)
        for (const row of parts) expect(row.id).toMatch(/^prt_[A-Za-z0-9]{26}$/)
        const permissions = db.prepare('SELECT id FROM permission').all() as Array<{ id: string }>
        expect(permissions).toHaveLength(1)
        for (const row of permissions) expect(row.id).toMatch(/^per_[A-Za-z0-9]{26}$/)
        const credentials = db.prepare('SELECT id FROM credential').all() as Array<{ id: string }>
        expect(credentials).toHaveLength(1)
        for (const row of credentials) expect(row.id).toMatch(/^cred_[A-Za-z0-9]{26}$/)
      } finally {
        db.close()
      }

      expect(source.lastMessageId).toMatch(/^msg_[A-Za-z0-9]{26}$/)
      const emit = createObservationEmitter(deps({
        FRESHELL_OPENCODE_ADOPTION_ROOT_SESSION_ID: source.rootId,
        FRESHELL_OPENCODE_ADOPTION_TAIL_MESSAGE_ID: source.lastMessageId,
      }))
      await emit(makeApi({
        sessionId: source.rootId,
        tuiMessages: [{ id: source.lastMessageId, sessionID: source.rootId }],
        nativeMessages: [{ info: { id: source.lastMessageId, sessionID: source.rootId }, parts: [] }],
      }))

      expect(writes).toHaveLength(1)
      expect(JSON.parse(writes[0].body).adoption_observation).toMatchObject({
        root_session_id: source.rootId,
        tail_message_id: source.lastMessageId,
        messages_read: 'success',
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not treat a route or requested session echo as hydrated state', async () => {
    const emit = createObservationEmitter(deps())
    await emit({ route: { current: { name: 'session', params: { sessionID: rootSessionId } } } })
    await emit(makeApi({ stateReady: false }))
    await emit(makeApi({ routeSessionId: 'ses_different1' }))
    expect(writes).toHaveLength(0)
  })

  it('requires exact root ownership and the current last message in hydrated TUI state', async () => {
    const emit = createObservationEmitter(deps())
    await emit(makeApi({ session: { id: rootSessionId, parentID: 'ses_parent1' } }))
    await emit(makeApi({ tuiMessages: [{ id: 'msg_stale1', sessionID: rootSessionId }] }))
    await emit(makeApi({ tuiMessages: [{ id: tailMessageId, sessionID: 'ses_wrongroot1' }] }))
    expect(writes).toHaveLength(0)
  })

  it('keeps provider message read failures distinct from an empty history', async () => {
    const emptyDeps = deps({
      FRESHELL_OPENCODE_ADOPTION_TAIL_MESSAGE_ID: undefined,
      FRESHELL_OPENCODE_ADOPTION_EXPECTED_EMPTY: 'true',
    })
    const emit = createObservationEmitter(emptyDeps)
    await emit(
      makeApi({
        tuiMessages: [],
        nativeRead: async () => {
          throw new Error('provider read failed')
        },
      }),
    )
    await emit(
      makeApi({
        tuiMessages: [],
        nativeRead: async () => ({ error: new Error('provider read failed') }),
      }),
    )
    await emit(
      makeApi({
        tuiMessages: [],
        nativeRead: async () => ({
          data: { data: [] },
          error: new Error('provider read failed'),
        }),
      }),
    )
    await emit(makeApi({ tuiMessages: [], nativeRead: async () => ({}) }))
    await emit(makeApi({ tuiMessages: [], nativeRead: async () => [] }))
    await emit(makeApi({ tuiMessages: [], nativeRead: async () => ({ data: null }) }))
    await emit(
      makeApi({
        tuiMessages: [],
        nativeRead: async () => ({ data: { data: 'not-an-array' } }),
      }),
    )
    await emit(makeApi({ tuiMessages: [], nativeRead: async () => ({ data: {} }) }))
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0].body).adoption_observation.messages_read).toBe('failed')
    expect(JSON.parse(writes[0].body).adoption_observation.tail_message_id).toBeNull()
  })

  it('confirms empty history only after exact session hydration and a successful error-aware native read', async () => {
    const env = {
      FRESHELL_OPENCODE_ADOPTION_TAIL_MESSAGE_ID: undefined,
      FRESHELL_OPENCODE_ADOPTION_EXPECTED_EMPTY: 'true',
    }
    const nativeRead = vi.fn(async () => ({ data: [] }))
    const emit = createObservationEmitter(deps(env))
    await emit(makeApi({ tuiMessages: [], nativeRead }))
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0].body).adoption_observation).toEqual({
      terminal_id: 'term-managed',
      root_session_id: rootSessionId,
      tail_message_id: null,
      evidence_generation: evidenceGeneration,
      incarnation_id: incarnationId,
      launch_nonce: launchNonce,
      hydrated: true,
      messages_read: 'empty_confirmed',
    })
    expect(nativeRead).toHaveBeenCalledWith(
      { sessionID: rootSessionId },
      { throwOnError: true },
    )

    writes.splice(0)
    await createObservationEmitter(deps(env))(
      makeApi({
        tuiMessages: [],
        nativeRead: async () => {
          throw new Error('cannot distinguish empty from a read failure')
        },
      }),
    )
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0].body).adoption_observation.messages_read).toBe('failed')
  })

  it('fails closed when any expected launch binding is missing or malformed', async () => {
    const malformed = [
      { FRESHELL_TERMINAL_ID: undefined },
      { FRESHELL_OPENCODE_ADOPTION_ROOT_SESSION_ID: undefined },
      { FRESHELL_OPENCODE_ADOPTION_EVIDENCE_GENERATION: undefined },
      { FRESHELL_OPENCODE_ADOPTION_INCARNATION_ID: undefined },
      { FRESHELL_OPENCODE_ADOPTION_LAUNCH_NONCE: undefined },
      {
        FRESHELL_OPENCODE_ADOPTION_TAIL_MESSAGE_ID: undefined,
        FRESHELL_OPENCODE_ADOPTION_EXPECTED_EMPTY: 'false',
      },
    ]
    for (const override of malformed) {
      await createObservationEmitter(deps(override))(makeApi())
    }
    expect(writes).toHaveLength(0)
  })

  it('uses the host-published current tail and evidence generation after full-store revalidation', async () => {
    const refreshedTail = 'msg_refreshedtail1'
    const refreshedGeneration = 'b'.repeat(64)
    const refreshedNonce = 'launch-refreshed1'
    const secondTail = 'msg_secondrefreshed1'
    const secondGeneration = 'c'.repeat(64)
    const secondNonce = 'launch-refreshed2'
    let expectedFile = JSON.stringify({
      terminal_id: 'term-managed',
      root_session_id: rootSessionId,
      root_tail: { state: 'message', data: { messageId: refreshedTail } },
      evidence_generation: refreshedGeneration,
      incarnation_id: incarnationId,
      launch_nonce: refreshedNonce,
    })
    const emitterDeps = Object.assign(deps(), {
      readExpectation: vi.fn(() => expectedFile),
    })
    const emit = createObservationEmitter(emitterDeps)
    await emit(makeApi({ tuiMessages: [{ id: refreshedTail, sessionID: rootSessionId }],
      nativeMessages: [{ info: { id: refreshedTail, sessionID: rootSessionId }, parts: [] }] }))

    expect(emitterDeps.readExpectation).toHaveBeenCalledWith(
      '/home/u/.freshell/session-signals/opencode-adoption/term-managed.expected.json',
    )
    expect(JSON.parse(writes[0].body).adoption_observation).toMatchObject({
      tail_message_id: refreshedTail,
      evidence_generation: refreshedGeneration,
      launch_nonce: refreshedNonce,
    })

    expectedFile = JSON.stringify({
      terminal_id: 'term-managed',
      root_session_id: rootSessionId,
      root_tail: { state: 'message', data: { message_id: secondTail } },
      evidence_generation: secondGeneration,
      incarnation_id: incarnationId,
      launch_nonce: secondNonce,
    })
    await emit(makeApi({ tuiMessages: [{ id: secondTail, sessionID: rootSessionId }],
      nativeMessages: [{ info: { id: secondTail, sessionID: rootSessionId }, parts: [] }] }))
    expect(writes).toHaveLength(2)
    expect(JSON.parse(writes[1].body).adoption_observation).toMatchObject({
      tail_message_id: secondTail,
      evidence_generation: secondGeneration,
      launch_nonce: secondNonce,
    })
  })

  it('blocks a refreshed expectation bound to another terminal or launch incarnation', async () => {
    const emitterDeps = Object.assign(deps(), {
      readExpectation: vi.fn(() => JSON.stringify({
        terminal_id: 'term-other',
        root_session_id: rootSessionId,
        root_tail: { state: 'message', data: { message_id: tailMessageId } },
        evidence_generation: 'b'.repeat(64),
        incarnation_id: incarnationId,
        launch_nonce: launchNonce,
      })),
    })
    await createObservationEmitter(emitterDeps)(makeApi())
    expect(writes).toHaveLength(0)

    const wrongIncarnation = Object.assign(deps(), {
      readExpectation: () => JSON.stringify({
        terminal_id: 'term-managed',
        root_session_id: rootSessionId,
        root_tail: { state: 'message', data: { message_id: tailMessageId } },
        evidence_generation: 'b'.repeat(64),
        incarnation_id: 'incarnation-old',
        launch_nonce: launchNonce,
      }),
    })
    await createObservationEmitter(wrongIncarnation)(makeApi())
    expect(writes).toHaveLength(0)
  })

  it('uses a refreshed qualified-empty expectation only after the error-aware exact-session read succeeds', async () => {
    const refreshedGeneration = 'd'.repeat(64)
    const refreshedNonce = 'launch-emptyrefresh'
    const emitterDeps = Object.assign(deps(), {
      readExpectation: () => JSON.stringify({
        terminal_id: 'term-managed',
        root_session_id: rootSessionId,
        root_tail: { state: 'qualified_empty' },
        evidence_generation: refreshedGeneration,
        incarnation_id: incarnationId,
        launch_nonce: refreshedNonce,
      }),
    })
    await createObservationEmitter(emitterDeps)(makeApi({
      tuiMessages: [],
      nativeRead: async () => ({ data: [] }),
    }))
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0].body).adoption_observation).toMatchObject({
      tail_message_id: null,
      evidence_generation: refreshedGeneration,
      launch_nonce: refreshedNonce,
      messages_read: 'empty_confirmed',
    })
  })

  it('recognizes incomplete managed launch metadata without allowing legacy fallback', () => {
    expect(hasAdoptionExpectation({
      FRESHELL_OPENCODE_ADOPTION_ROOT_SESSION_ID: rootSessionId,
    })).toBe(true)
    expect(hasAdoptionExpectation({ HOME: '/home/u' })).toBe(false)
  })
})

describe('default export (TuiPluginModule)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('HOME', '/h')
    vi.stubEnv('FRESHELL_TERMINAL_ID', 'term-tui')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('records current native read and busy wake timing without publishing unqualified identity', async () => {
    const home = mkdtempSync(join(tmpdir(), 'freshell-native-opencode-progress-'))
    const root = 'ses_progressroot1'
    const launch = { incarnationId: 'incarnation-progress1', launchNonce: 'launch-progress1', evidenceRevision: 4,
      executionGeneration: 2, requestedNativeSessionId: root }
    const directory = join(home, '.freshell/native-identity', launch.launchNonce)
    vi.stubEnv('HOME', home)
    vi.stubEnv('FRESHELL_NATIVE_IDENTITY_LAUNCH', JSON.stringify(launch))
    vi.stubEnv('FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR', directory)
    const session = { id: root, parentID: null }
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    const get = vi.fn(() => pending)
    const renderers: Record<string, (context: unknown, props: unknown) => unknown> = {}
    const abort = new AbortController()
    const progress = (stage: string) => JSON.parse(readFileSync(join(directory, 'opencode-native-diagnostics', stage + '.json'), 'utf8'))
    try {
      plugin.tui({ state: { ready: true, session: { get: () => session, messages: () => [] } },
        client: { session: { get, messages: async () => ({ data: [] }) } },
        route: { current: { name: 'session', params: { sessionID: root } } },
        slots: { register: ({ slots }: { slots: typeof renderers }) => { Object.assign(renderers, slots) } },
        lifecycle: { signal: abort.signal } })
      await vi.advanceTimersByTimeAsync(0)
      expect(get).toHaveBeenCalledOnce()
      expect(progress('native_read_pending')).toMatchObject({ severity: 'info', nativeSessionId: root,
        incarnationId: launch.incarnationId, launchNonce: launch.launchNonce, evidenceRevision: 4, executionGeneration: 2,
        trigger: 'initial' })
      await vi.advanceTimersByTimeAsync(75)
      expect(renderers.session_prompt({}, {})).toBeNull()
      const busy = progress('in_flight')
      expect(busy.trigger).toBe('session_prompt')
      expect(busy.observedAtMs).toBe(Date.now())
      expect(busy.elapsedMs).toBe(75)
      expect(existsSync(join(directory, 'opencode-loaded.json'))).toBe(false)
      finish({ error: 'private transcript or provider error', data: { ...session, id: 'ses_otherroot1' } })
      await vi.advanceTimersByTimeAsync(0)
      expect(progress('native_read_settled').observedAtMs).toBe(Date.now())
      expect(progress('refused')).toMatchObject({ severity: 'warning', reason: 'native_root_load_failed' })
      expect(existsSync(join(directory, 'opencode-loaded.json'))).toBe(false)
      expect(JSON.stringify(progress('refused'))).not.toContain('private transcript or provider error')
    } finally { abort.abort(); rmSync(home, { recursive: true, force: true }) }
  })

  it.each(['hydrated', 'unloaded', 'changed-route', 'not-ready', 'wrong-native-root', 'disposed'])
    ('overlaps exact native history reading with TUI hydration and requires their current conjunction: %s', async (condition) => {
    const home = mkdtempSync(join(tmpdir(), 'freshell-native-opencode-overlap-'))
    const root = 'ses_overlaproot1'
    const launch = { incarnationId: 'incarnation-overlap1', launchNonce: 'launch-overlap1', evidenceRevision: 4,
      executionGeneration: 2, requestedNativeSessionId: root }
    const directory = join(home, '.freshell/native-identity', launch.launchNonce)
    vi.stubEnv('HOME', home)
    vi.stubEnv('FRESHELL_NATIVE_IDENTITY_LAUNCH', JSON.stringify(launch))
    vi.stubEnv('FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR', directory)
    const session = { id: root, parentID: null }
    let hydrated = false
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    const get = vi.fn(() => pending)
    const abort = new AbortController()
    const state = { ready: true, session: { get: () => hydrated ? session : undefined, messages: () => [] } }
    const route = { current: { name: 'session', params: { sessionID: root } } }
    try {
      plugin.tui({ state,
        client: { session: { get, messages: async () => ({ data: [] }) } },
        route, lifecycle: { signal: abort.signal } })
      await vi.advanceTimersByTimeAsync(0)
      expect(get).toHaveBeenCalledOnce()
      expect(existsSync(join(directory, 'opencode-loaded.json'))).toBe(false)
      await vi.advanceTimersByTimeAsync(75)
      hydrated = condition !== 'unloaded'
      if (condition === 'changed-route') route.current.params.sessionID = 'ses_otherroot1'
      if (condition === 'not-ready') state.ready = false
      if (condition === 'disposed') abort.abort()
      finish({ data: condition === 'wrong-native-root' ? { ...session, id: 'ses_otherroot1' } : session })
      await vi.advanceTimersByTimeAsync(0)
      if (condition !== 'hydrated') {
        expect(existsSync(join(directory, 'opencode-loaded.json'))).toBe(false)
        expect(existsSync(join(directory, 'opencode-native-diagnostics/publication_succeeded.json'))).toBe(false)
        return
      }
      expect(JSON.parse(readFileSync(join(directory, 'opencode-loaded.json'), 'utf8'))).toMatchObject({ launch,
        native: { session_id: root, hydrated: true, active_message_count: 0 } })
      const publication = JSON.parse(readFileSync(join(directory, 'opencode-native-diagnostics/publication_succeeded.json'), 'utf8'))
      expect(publication.observedAtMs).toBe(Date.now())
    } finally { abort.abort(); rmSync(home, { recursive: true, force: true }) }
  })

  it.each(['create', 'resume'])('observes managed nonadoption native %s before input through the actual TUI loader', async (mode) => {
    const home = mkdtempSync(join(tmpdir(), 'freshell-native-opencode-'))
    const root = 'ses_nativeroot1'
    const launch = { incarnationId: 'incarnation-native1', launchNonce: 'launch-native1', evidenceRevision: 4,
      executionGeneration: 2, requestedNativeSessionId: mode === 'resume' ? root : null }
    vi.stubEnv('HOME', home)
    vi.stubEnv('FRESHELL_NATIVE_IDENTITY_LAUNCH', JSON.stringify(launch))
    vi.stubEnv('FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR', join(home, '.freshell/native-identity', launch.launchNonce))
    const session = { id: root, parentID: null }
    const create = vi.fn(async () => ({ data: session }))
    const route = { current: mode === 'resume' ? { name: 'session', params: { sessionID: root } } : { name: 'home' },
      navigate: vi.fn((name: unknown, params?: { sessionID?: string }) => {
        // Pinned public TUI navigation takes a route name plus parameters.
        // The internal {type,...} route is treated as a plugin route instead.
        if (name !== 'session' || typeof params?.sessionID !== 'string') {
          route.current = { name: 'unselected-plugin-route' }
          return
        }
        route.current = { name, params: { sessionID: params.sessionID } }
      }) }
    const abort = new AbortController()
    try {
      const initialAt = Date.now()
      plugin.tui({
        state: { ready: true, session: { get: () => session, messages: () => [] } },
        client: { session: { create, get: async () => ({ data: session }), messages: async () => ({ data: [] }) } },
        route, lifecycle: { signal: abort.signal },
      })
      await vi.advanceTimersByTimeAsync(1000)
      expect(create).toHaveBeenCalledTimes(mode === 'create' ? 1 : 0)
      expect(route.current).toEqual({ name: 'session', params: { sessionID: root } })
      const file = join(home, '.freshell/native-identity', launch.launchNonce, 'opencode-loaded.json')
      expect(existsSync(file)).toBe(true)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ launch,
        native: { session_id: root, parent_id: null, hydrated: true, messages_read: 'empty_confirmed', active_message_count: 0 } })
      const diagnostics = join(dirname(file), 'opencode-native-diagnostics')
      const publication = JSON.parse(readFileSync(join(diagnostics, 'publication_succeeded.json'), 'utf8'))
      expect(publication).toMatchObject({ severity: 'info', nativeSessionId: root,
        incarnationId: launch.incarnationId, launchNonce: launch.launchNonce, observedAtMs: initialAt })
      const duplicate = JSON.parse(readFileSync(join(diagnostics, 'duplicate.json'), 'utf8'))
      expect(duplicate).toMatchObject({ severity: 'info', observedAtMs: Date.now(), nativeSessionId: root,
        trigger: 'poll', launchNonce: launch.launchNonce })
      expect(existsSync(join(diagnostics, 'native_create_settled.json'))).toBe(mode === 'create')
      if (mode === 'create') {
        const created = JSON.parse(readFileSync(join(diagnostics, 'native_create_settled.json'), 'utf8'))
        expect(created.nativeSessionId).toBe(root)
        expect(created.observedAtMs).toBeLessThanOrEqual(publication.observedAtMs)
      }
      abort.abort()
      const publishedDiagnostics = readdirSync(diagnostics).map(name => readFileSync(join(diagnostics, name), 'utf8'))
      await vi.advanceTimersByTimeAsync(2000)
      expect(readdirSync(diagnostics).map(name => readFileSync(join(diagnostics, name), 'utf8'))).toEqual(publishedDiagnostics)
      const legacy = join(home, '.freshell/session-signals/opencode')
      expect(readdirSync(legacy).map(name => JSON.parse(readFileSync(join(legacy, name), 'utf8')))).toEqual([
        { hello: true, source: 'opencode-tui-plugin' },
      ])
    } finally { abort.abort(); rmSync(home, { recursive: true, force: true }) }
  })

  it.each(['qualified', 'wrong-root', 'parent-root', 'unhydrated-tail', 'unhydrated-parts', 'changed-route', 'dispose', 'resume-pinned'])
    ('follows a fresh native root switch only with the complete %s loader conjunction', async (condition) => {
      const home = mkdtempSync(join(tmpdir(), 'freshell-native-opencode-switch-'))
      const original = 'ses_originalnative1', selected = 'ses_selectednative1', tail = 'msg_selectednative1'
      const launch = { incarnationId: 'incarnation-native1', launchNonce: 'launch-native1', evidenceRevision: 4,
        executionGeneration: 2, requestedNativeSessionId: condition === 'resume-pinned' ? original : null }
      vi.stubEnv('HOME', home)
      vi.stubEnv('FRESHELL_NATIVE_IDENTITY_LAUNCH', JSON.stringify(launch))
      vi.stubEnv('FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR', join(home, '.freshell/native-identity', launch.launchNonce))
      const route = { current: { name: 'session', params: { sessionID: original } },
        navigate: (name: string, params: { sessionID: string }) => { route.current = { name, params } } }
      const abort = new AbortController()
      const session = (id: string) => ({ id, parentID: null })
      const info = { id: tail, sessionID: selected, role: 'user' }
      const part = { id: 'prt_selectednative1', messageID: tail, sessionID: selected, type: 'text' }
      let switching = false
      const create = vi.fn(async () => ({ data: session(original) }))
      const get = vi.fn(async ({ sessionID }: { sessionID: string }) => {
        if (switching && condition === 'changed-route') route.current.params.sessionID = original
        if (switching && condition === 'dispose') abort.abort()
        return { data: switching && condition === 'wrong-root' ? session(original)
          : switching && condition === 'parent-root' ? { ...session(sessionID), parentID: original } : session(sessionID) }
      })
      try {
        plugin.tui({ route, lifecycle: { signal: abort.signal },
          state: { ready: true, part: () => condition === 'unhydrated-parts' ? [] : [part], session: {
            get: session, messages: (id: string) => id === original ? []
              : condition === 'unhydrated-tail' ? [] : [info],
          } },
          client: { session: { create, get, messages: async ({ sessionID }: { sessionID: string }) => ({
            data: sessionID === original ? [] : [{ info, parts: [part] }],
          }) } },
        })
        await vi.advanceTimersByTimeAsync(0)
        const file = join(home, '.freshell/native-identity', launch.launchNonce, 'opencode-loaded.json')
        expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ launch, native: { session_id: original, hydrated: true } })
        switching = true
        route.navigate('session', { sessionID: selected })
        await vi.advanceTimersByTimeAsync(1000)
        const emitted = JSON.parse(readFileSync(file, 'utf8'))
        if (condition === 'qualified') {
          expect(emitted).toMatchObject({ launch, native: { session_id: selected, parent_id: null,
            hydrated: true, messages_read: 'success', active_message_count: 1, tail_message_id: tail } })
          expect(get).toHaveBeenLastCalledWith({ sessionID: selected }, { throwOnError: true })
        } else {
          expect(emitted.native.hydrated).toBe(false)
        }
        expect(create).toHaveBeenCalledTimes(condition === 'resume-pinned' ? 0 : 1)
        if (condition === 'resume-pinned') expect(get).toHaveBeenCalledOnce()
      } finally { abort.abort(); rmSync(home, { recursive: true, force: true }) }
    })

  it.each([
    ['get', 'qualified'], ['messages', 'qualified'],
    ['get', 'rejected'], ['messages', 'rejected'],
  ] as const)('withdraws a fresh native root before deferred %s settles %s', async (firstRead, outcome) => {
    const home = mkdtempSync(join(tmpdir(), 'freshell-native-opencode-pending-switch-'))
    const original = 'ses_originalnative1', selected = 'ses_selectednative1', tail = 'msg_selectednative1'
    const launch = { incarnationId: 'incarnation-native1', launchNonce: 'launch-native1', evidenceRevision: 4,
      executionGeneration: 2, requestedNativeSessionId: null }
    const directory = join(home, '.freshell/native-identity', launch.launchNonce)
    vi.stubEnv('HOME', home)
    vi.stubEnv('FRESHELL_NATIVE_IDENTITY_LAUNCH', JSON.stringify(launch))
    vi.stubEnv('FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR', directory)
    const route = { current: { name: 'session', params: { sessionID: original } },
      navigate: (name: string, params: { sessionID: string }) => { route.current = { name, params } } }
    const session = (id: string) => ({ id, parentID: null })
    const info = { id: tail, sessionID: selected, role: 'user' }
    const part = { id: 'prt_selectednative1', messageID: tail, sessionID: selected, type: 'text' }
    const results = { get: { data: session(selected) }, messages: { data: [{ info, parts: [part] }] } }
    const deferred = () => {
      let resolve!: (value: unknown) => void
      let reject!: (reason: Error) => void
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
      })
      return { promise, resolve, reject }
    }
    const reads = { get: deferred(), messages: deferred() }
    const get = vi.fn(async ({ sessionID }: { sessionID: string }) => sessionID === original
      ? { data: session(original) } : reads.get.promise)
    const messages = vi.fn(async ({ sessionID }: { sessionID: string }) => sessionID === original
      ? { data: [] } : reads.messages.promise)
    const create = vi.fn(async () => ({ data: session(original) }))
    const abort = new AbortController()
    const renderers: Record<string, (context: unknown, props: unknown) => unknown> = {}
    const file = join(directory, 'opencode-loaded.json')
    const observation = () => JSON.parse(readFileSync(file, 'utf8'))
    const expectUnqualified = () => expect(observation()).toMatchObject({ launch,
      native: { session_id: original, hydrated: false } })
    try {
      plugin.tui({ route, lifecycle: { signal: abort.signal },
        slots: { register: ({ slots }: { slots: typeof renderers }) => { Object.assign(renderers, slots) } },
        state: { ready: true, part: () => [part], session: {
          get: session, messages: (id: string) => id === original ? [] : [info],
        } }, client: { session: { create, get, messages } } })
      await vi.advanceTimersByTimeAsync(0)
      expect(observation()).toMatchObject({ launch, native: { session_id: original, hydrated: true } })
      route.navigate('session', { sessionID: selected })
      await vi.advanceTimersByTimeAsync(1000)
      expect(get).toHaveBeenLastCalledWith({ sessionID: selected }, { throwOnError: true })
      expect(messages).toHaveBeenLastCalledWith({ sessionID: selected }, { throwOnError: true })
      expectUnqualified()
      await vi.advanceTimersByTimeAsync(1000)
      expect(renderers.session_prompt({}, {})).toBeNull()
      expect(get).toHaveBeenCalledTimes(2)
      expect(messages).toHaveBeenCalledTimes(2)
      expectUnqualified()
      const second = firstRead === 'get' ? 'messages' : 'get'
      if (outcome === 'rejected') reads[firstRead].reject(new Error('controlled native read failure'))
      else reads[firstRead].resolve(results[firstRead])
      await vi.advanceTimersByTimeAsync(0)
      expectUnqualified()
      reads[second].resolve(results[second])
      await vi.advanceTimersByTimeAsync(0)
      if (outcome === 'qualified') {
        expect(observation()).toMatchObject({ launch, native: { session_id: selected, parent_id: null,
          hydrated: true, messages_read: 'success', active_message_count: 1, tail_message_id: tail } })
      } else {
        expectUnqualified()
        expect(JSON.parse(readFileSync(join(directory, 'opencode-refused.json'), 'utf8')).reason)
          .toBe(firstRead === 'get' ? 'native_root_load_failed' : 'native_history_load_failed')
      }
      expect(create).toHaveBeenCalledOnce()
    } finally { abort.abort(); rmSync(home, { recursive: true, force: true }) }
  })

  it.each(['wrong-root', 'history-error', 'unhydrated-tail', 'unhydrated-parts', 'parent-root', 'malformed-binding'])
    ('keeps managed nonadoption %s unobserved without a legacy fallback', async (fault) => {
      const home = mkdtempSync(join(tmpdir(), 'freshell-native-opencode-refusal-'))
      const root = 'ses_nativefault1', tail = 'msg_nativefault1'
      const launch = { incarnationId: 'incarnation-native1', launchNonce: 'launch-native1', evidenceRevision: 4,
        executionGeneration: 2, requestedNativeSessionId: root }
      vi.stubEnv('HOME', home)
      vi.stubEnv('FRESHELL_NATIVE_IDENTITY_LAUNCH', fault === 'malformed-binding' ? '{}' : JSON.stringify(launch))
      vi.stubEnv('FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR', join(home, '.freshell/native-identity', launch.launchNonce))
      const session = { id: root, parentID: null }
      const info = { id: tail, sessionID: root }
      const create = vi.fn()
      const abort = new AbortController()
      try {
        plugin.tui({
          state: { ready: true, part: () => [], session: { get: () => session,
            messages: () => fault === 'unhydrated-tail' ? [] : [info] } },
          client: { session: { create, get: async () => ({ data: fault === 'wrong-root'
            ? { ...session, id: 'ses_wrongnative1' } : fault === 'parent-root' ? { ...session, parentID: 'ses_parent1' } : session }),
            messages: async () => { if (fault === 'history-error') throw new Error('private native error')
              return { data: [{ info, parts: fault === 'unhydrated-parts' ? [{ id: 'prt_native1' }] : [] }] } } } },
          route: { current: { name: 'session', params: { sessionID: root } } }, lifecycle: { signal: abort.signal },
        })
        await vi.advanceTimersByTimeAsync(3000)
        expect(create).not.toHaveBeenCalled()
        expect(existsSync(join(home, '.freshell/native-identity', launch.launchNonce, 'opencode-loaded.json'))).toBe(false)
        const legacy = join(home, '.freshell/session-signals/opencode')
        expect(readdirSync(legacy).map(name => JSON.parse(readFileSync(join(legacy, name), 'utf8')))).toEqual([
          { hello: true, source: 'opencode-tui-plugin' },
        ])
      } finally { abort.abort(); rmSync(home, { recursive: true, force: true }) }
    })

  it.each(['uncertain', 'disposed'])('never repeats or publishes an %s native creation', async (fault) => {
    const home = mkdtempSync(join(tmpdir(), 'freshell-native-opencode-create-'))
    const launch = { incarnationId: 'incarnation-native1', launchNonce: 'launch-native1', evidenceRevision: 4,
      executionGeneration: 2, requestedNativeSessionId: null }
    vi.stubEnv('HOME', home)
    vi.stubEnv('FRESHELL_NATIVE_IDENTITY_LAUNCH', JSON.stringify(launch))
    vi.stubEnv('FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR', join(home, '.freshell/native-identity', launch.launchNonce))
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    const create = vi.fn(() => fault === 'disposed' ? pending : Promise.reject(new Error('private network error')))
    const navigate = vi.fn()
    const abort = new AbortController()
    try {
      plugin.tui({ state: { ready: true }, client: { session: { create } },
        route: { current: { name: 'home' }, navigate }, lifecycle: { signal: abort.signal } })
      await Promise.resolve()
      if (fault === 'disposed') { abort.abort(); finish({ data: { id: 'ses_disposed1', parentID: null } }) }
      await vi.advanceTimersByTimeAsync(3000)
      expect(create).toHaveBeenCalledOnce()
      expect(navigate).not.toHaveBeenCalled()
      expect(existsSync(join(home, '.freshell/native-identity', launch.launchNonce, 'opencode-loaded.json'))).toBe(false)
    } finally { abort.abort(); rmSync(home, { recursive: true, force: true }) }
  })

  it.each(['route-change', 'dispose'])('withdraws an already observed managed native loader on %s', async (edge) => {
    const home = mkdtempSync(join(tmpdir(), 'freshell-native-opencode-withdraw-'))
    const root = 'ses_loadednative1'
    const launch = { incarnationId: 'incarnation-native1', launchNonce: 'launch-native1', evidenceRevision: 4,
      executionGeneration: 2, requestedNativeSessionId: root }
    vi.stubEnv('HOME', home)
    vi.stubEnv('FRESHELL_NATIVE_IDENTITY_LAUNCH', JSON.stringify(launch))
    vi.stubEnv('FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR', join(home, '.freshell/native-identity', launch.launchNonce))
    const session = { id: root, parentID: null }
    const get = vi.fn(async () => ({ data: session }))
    const route = { current: { name: 'session', params: { sessionID: root } } }
    const abort = new AbortController()
    let dispose!: () => void
    try {
      plugin.tui({ state: { ready: true, session: { get: () => session, messages: () => [] } },
        client: { session: { get, messages: async () => ({ data: [] }) } }, route,
        lifecycle: { signal: abort.signal, onDispose: (callback: () => void) => { dispose = callback } } })
      await vi.advanceTimersByTimeAsync(0)
      const file = join(home, '.freshell/native-identity', launch.launchNonce, 'opencode-loaded.json')
      expect(JSON.parse(readFileSync(file, 'utf8')).native.hydrated).toBe(true)
      if (edge === 'route-change') route.current = { name: 'session', params: { sessionID: 'ses_othernative1' } }
      else dispose()
      await vi.advanceTimersByTimeAsync(1000)
      expect(JSON.parse(readFileSync(file, 'utf8')).native.hydrated).toBe(false)
      expect(get).toHaveBeenCalledOnce()
    } finally { abort.abort(); rmSync(home, { recursive: true, force: true }) }
  })

  it.each([
    ['route-change', 'poll'], ['readiness-loss', 'poll'], ['unchanged', 'poll'],
    ['route-change', 'session_prompt'], ['readiness-loss', 'session_prompt'], ['unchanged', 'session_prompt'],
  ] as const)('rechecks an observed native context on %s during a pending same-root read via %s', async (condition, wake) => {
    const home = mkdtempSync(join(tmpdir(), 'freshell-native-opencode-pending-refresh-'))
    const root = 'ses_loadednative1'
    const launch = { incarnationId: 'incarnation-native1', launchNonce: 'launch-native1', evidenceRevision: 4,
      executionGeneration: 2, requestedNativeSessionId: null }
    const directory = join(home, '.freshell/native-identity', launch.launchNonce)
    vi.stubEnv('HOME', home)
    vi.stubEnv('FRESHELL_NATIVE_IDENTITY_LAUNCH', JSON.stringify(launch))
    vi.stubEnv('FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR', directory)
    const session = { id: root, parentID: null }
    const route = { current: { name: 'session', params: { sessionID: root } },
      navigate: (name: string, params: { sessionID: string }) => { route.current = { name, params } } }
    const state = { ready: true, session: { get: () => session, messages: () => [] } }
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    const get = vi.fn(async () => ({ data: session }))
    const messages = vi.fn().mockResolvedValueOnce({ data: [] }).mockReturnValue(pending)
    const renderers: Record<string, (context: unknown, props: unknown) => unknown> = {}
    const file = join(directory, 'opencode-loaded.json')
    const observation = () => JSON.parse(readFileSync(file, 'utf8'))
    const abort = new AbortController()
    try {
      plugin.tui({ state, route, client: { session: { create: async () => ({ data: session }), get, messages } },
        slots: { register: ({ slots }: { slots: typeof renderers }) => { Object.assign(renderers, slots) } },
        lifecycle: { signal: abort.signal } })
      await vi.advanceTimersByTimeAsync(0)
      expect(observation()).toMatchObject({ launch, native: { session_id: root, hydrated: true } })
      await vi.advanceTimersByTimeAsync(1000)
      expect(messages).toHaveBeenCalledTimes(2)
      expect(messages).toHaveBeenLastCalledWith({ sessionID: root }, { throwOnError: true })
      expect(observation().native.hydrated).toBe(true)

      if (condition === 'route-change') route.current.params.sessionID = 'ses_othernative1'
      if (condition === 'readiness-loss') state.ready = false
      if (wake === 'poll') await vi.advanceTimersByTimeAsync(1000)
      else expect(renderers.session_prompt({}, {})).toBeNull()

      expect(observation()).toMatchObject({ launch, native: { session_id: root, hydrated: condition === 'unchanged' } })
      expect(get).toHaveBeenCalledTimes(2)
      expect(messages).toHaveBeenCalledTimes(2)
      const beforeCompletion = readFileSync(file, 'utf8')
      finish({ data: [] })
      await vi.advanceTimersByTimeAsync(0)
      expect(readFileSync(file, 'utf8')).toBe(beforeCompletion)
      expect(messages).toHaveBeenCalledTimes(2)
    } finally { abort.abort(); rmSync(home, { recursive: true, force: true }) }
  })

  it('records actual mounted native slot wake counts while leaving unhydrated history blocked', async () => {
    const home = mkdtempSync(join(tmpdir(), 'freshell-native-opencode-mounted-'))
    const root = 'ses_mounted1', tail = 'msg_mounted1'
    vi.stubEnv('HOME', home)
    for (const [key,value] of Object.entries({
      FRESHELL_OPENCODE_ADOPTION_ROOT_SESSION_ID:root, FRESHELL_OPENCODE_ADOPTION_TAIL_MESSAGE_ID:tail,
      FRESHELL_OPENCODE_ADOPTION_EXPECTED_EMPTY:'false', FRESHELL_OPENCODE_ADOPTION_EVIDENCE_GENERATION:'a'.repeat(64),
      FRESHELL_OPENCODE_ADOPTION_INCARNATION_ID:'incarnation-mounted', FRESHELL_OPENCODE_ADOPTION_LAUNCH_NONCE:'launch-mounted',
    })) vi.stubEnv(key,value)
    const session = {id:root,parentID:null}, info={id:tail,sessionID:root}
    const slots: Record<string,(context:unknown,props:unknown)=>unknown>={}
    const abort = new AbortController()
    const diagnostic = join(home,'.freshell/session-signals/opencode-adoption-diagnostics/term-tui.json')
    try {
      plugin.tui({state:{ready:true,session:{get:()=>session,messages:()=>[]}},
        client:{session:{get:async()=>({data:session}),messages:async()=>({data:[{info,parts:[]}]})}},
        route:{current:{name:'session',params:{sessionID:root}}},
        slots:{register:(contribution:{slots:typeof slots})=>{Object.assign(slots,contribution.slots);return 'host-registration'}},
        lifecycle:{signal:abort.signal}})
      await vi.advanceTimersByTimeAsync(0)
      const initial=JSON.parse(readFileSync(diagnostic,'utf8'))
      expect(initial.trigger).toBe('initial')
      expect(initial.registeredSlotCount).toBe(2)
      expect(initial.sessionPromptRenderCount).toBe(0)
      expect(initial.sidebarTitleRenderCount).toBe(0)
      for(const slot of ['session_prompt','sidebar_title']) {
        expect(slots[slot]({},{})).toBeNull()
        await vi.advanceTimersByTimeAsync(0)
        const actual=JSON.parse(readFileSync(diagnostic,'utf8'))
        expect(actual.trigger).toBe(slot)
        expect(actual.sessionPromptRenderCount).toBe(1)
        expect(actual.sidebarTitleRenderCount).toBe(slot==='sidebar_title'?1:0)
        expect(actual.reason).toBe('tail_not_hydrated')
        expect(actual.elapsedMs).toBeGreaterThanOrEqual(0)
      }
      expect(existsSync(join(home,'.freshell/session-signals/opencode-adoption'))).toBe(false)
    } finally {abort.abort();rmSync(home,{recursive:true,force:true})}
  })

  it('has the TuiPluginModule shape', () => {
    expect(plugin.id).toBe('freshell-rebind')
    expect(typeof plugin.tui).toBe('function')
  })

  it.each(['abort', 'dispose'])('does not publish a pending native read or reuse retained slots after lifecycle %s', async (edge) => {
    const home = mkdtempSync(join(tmpdir(), 'freshell-native-disposal-'))
    vi.stubEnv('HOME', home)
    const root = 'ses_disposal1', tail = 'msg_disposal1'
    for (const [key, value] of Object.entries({
      FRESHELL_OPENCODE_ADOPTION_ROOT_SESSION_ID: root,
      FRESHELL_OPENCODE_ADOPTION_TAIL_MESSAGE_ID: tail,
      FRESHELL_OPENCODE_ADOPTION_EXPECTED_EMPTY: 'false',
      FRESHELL_OPENCODE_ADOPTION_EVIDENCE_GENERATION: 'a'.repeat(64),
      FRESHELL_OPENCODE_ADOPTION_INCARNATION_ID: 'incarnation-disposal',
      FRESHELL_OPENCODE_ADOPTION_LAUNCH_NONCE: 'launch-disposal',
    })) vi.stubEnv(key, value)
    const session = { id: root, parentID: null }
    const info = { id: tail, sessionID: root }
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    const messages = vi.fn(() => pending)
    const abort = new AbortController()
    let dispose!: () => void
    const slots: Record<string, (context: unknown, props: unknown) => unknown> = {}
    try {
      plugin.tui({
        state: { ready: true, session: { get: () => session, messages: () => [info] } },
        client: { session: { get: async () => ({ data: session }), messages } },
        route: { current: { name: 'session', params: { sessionID: root } } },
        slots: { register: (contribution: { slots: typeof slots }) => Object.assign(slots, contribution.slots) },
        lifecycle: { signal: abort.signal, onDispose: (callback: () => void) => { dispose = callback } },
      })
      await Promise.resolve()
      expect(messages).toHaveBeenCalledOnce()
      if (edge === 'abort') abort.abort()
      else dispose()
      finish({ data: [{ info, parts: [] }] })
      await vi.advanceTimersByTimeAsync(0)
      expect(existsSync(join(home, '.freshell/session-signals/opencode-adoption'))).toBe(false)
      expect(slots.session_prompt({}, { sessionID: root })).toBeNull()
      await vi.advanceTimersByTimeAsync(1000)
      expect(messages).toHaveBeenCalledOnce()
      expect(existsSync(join(home, '.freshell/session-signals/opencode-adoption'))).toBe(false)
    } finally {
      abort.abort()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('registers slots, polls route.current, and stops on lifecycle abort — without throwing', () => {
    const home = mkdtempSync(join(tmpdir(), 'freshell-slot-api-'))
    vi.stubEnv('HOME', home)
    const slots: Record<string, (context: unknown, props: unknown) => unknown> = {}
    const contributions: Array<{ slots: Record<string, (context: unknown, props: unknown) => unknown> }> = []
    const abort = new AbortController()
    const api = {
      slots: {
        register: (contribution: { slots: Record<string, (context: unknown, props: unknown) => unknown> }) => {
          contributions.push(contribution)
          Object.assign(slots, contribution.slots)
          return 'freshell-rebind'
        },
      },
      route: { current: { name: 'session', params: { sessionID: 'ses_poll1' } } },
      lifecycle: { signal: abort.signal },
    }
    try {
      expect(() => plugin.tui(api)).not.toThrow()
      expect(contributions).toHaveLength(2)
      expect(contributions.map((contribution) => Object.keys(contribution.slots))).toEqual([
        ['session_prompt'],
        ['sidebar_title'],
      ])
      expect(Object.keys(slots).sort()).toEqual(['session_prompt', 'sidebar_title'])
      // OpenCode 1.18.21 calls each slot renderer with context and its typed props.
      // Returning null contributes no UI and leaves the host slot intact.
      expect(slots.session_prompt({}, { session_id: 'ses_slot1' })).toBeNull()
      const signalDir = join(home, '.freshell', 'session-signals', 'opencode')
      const signalFiles = readdirSync(signalDir).filter((name) => name.endsWith('.json'))
      const signals = signalFiles.map((name) => JSON.parse(readFileSync(join(signalDir, name), 'utf-8')))
      expect(signals).toContainEqual({
        session_id: 'ses_slot1',
        source: 'opencode-tui-plugin',
      })
      // polling keeps running until abort, then stops
      expect(() => vi.advanceTimersByTime(10_000)).not.toThrow()
      abort.abort()
      expect(() => vi.advanceTimersByTime(10_000)).not.toThrow()
    } finally {
      rmSync(home, { recursive: true, force: true })
      vi.stubEnv('HOME', '/h')
    }
  })

  it('no-ops silently when the API surface is absent or hostile (version tolerance)', () => {
    expect(() => plugin.tui(undefined)).not.toThrow()
    expect(() => plugin.tui({})).not.toThrow()
    expect(() =>
      plugin.tui({
        slots: {
          register: () => {
            throw new Error('changed API')
          },
        },
        get route(): never {
          throw new Error('changed API')
        },
      }),
    ).not.toThrow()
    vi.advanceTimersByTime(10_000)
  })

  it('writes a plugin-alive hello at tui() startup, even against a hostile api surface', () => {
    const home = mkdtempSync(join(tmpdir(), 'freshell-hello-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('FRESHELL_TERMINAL_ID', 'term-hello')

    const hostileApi = new Proxy({}, {
      get() {
        throw new Error('API drift')
      },
    })
    expect(() => plugin.tui(hostileApi)).not.toThrow()

    const dir = join(home, '.freshell', 'session-signals', 'opencode')
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^term-hello__\d{14}-\d{6}-\d+\.json$/)
    expect(JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'))).toEqual({
      hello: true,
      source: 'opencode-tui-plugin',
    })
  })

  it('does not fall back to route-only rebind signals for an incomplete managed expectation', () => {
    const home = mkdtempSync(join(tmpdir(), 'freshell-managed-opencode-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('FRESHELL_TERMINAL_ID', 'term-managed-route')
    vi.stubEnv('FRESHELL_OPENCODE_ADOPTION_ROOT_SESSION_ID', 'ses_requested1')
    const abort = new AbortController()
    plugin.tui({
      route: { current: { name: 'session', params: { sessionID: 'ses_requested1' } } },
      lifecycle: { signal: abort.signal },
    })

    vi.advanceTimersByTime(1_000)
    abort.abort()

    const helloDir = join(home, '.freshell', 'session-signals', 'opencode')
    const helloFiles = readdirSync(helloDir).filter((name) => name.endsWith('.json'))
    expect(helloFiles).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(helloDir, helloFiles[0]), 'utf-8'))).toEqual({
      hello: true,
      source: 'opencode-tui-plugin',
    })
    expect(existsSync(join(home, '.freshell', 'session-signals', 'opencode-adoption'))).toBe(false)
  })
})
