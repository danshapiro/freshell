// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import plugin, {
  createEmitter,
  createObservationEmitter,
  emitHello,
  extractSessionId,
  hasAdoptionExpectation,
  type EmitterDeps,
} from '../../../extensions/opencode/freshell-rebind-plugin'
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
  })

  const makeApi = (options: {
    sessionId?: string
    routeSessionId?: string
    stateReady?: boolean
    session?: Record<string, unknown> | undefined
    tuiMessages?: unknown
    nativeMessages?: unknown
    nativeRead?: () => Promise<unknown>
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

  it('has the TuiPluginModule shape', () => {
    expect(plugin.id).toBe('freshell-rebind')
    expect(typeof plugin.tui).toBe('function')
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
