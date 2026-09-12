import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import plugin, {
  createEmitter,
  emitHello,
  extractSessionId,
  type EmitterDeps,
} from '../../../extensions/opencode/freshell-rebind-plugin'

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
    const slots: Record<string, (ctx: unknown) => unknown> = {}
    const abort = new AbortController()
    const api = {
      slots: { register: (name: string, fn: (ctx: unknown) => unknown) => (slots[name] = fn) },
      route: { current: { name: 'session', params: { sessionID: 'ses_poll1' } } },
      lifecycle: { signal: abort.signal },
    }
    expect(() => plugin.tui(api)).not.toThrow()
    expect(Object.keys(slots).sort()).toEqual(['session_prompt', 'sidebar_title'])
    // slot renderer must return undefined (never replace host content)
    expect(slots.session_prompt({ session_id: 'ses_slot1' })).toBeUndefined()
    // polling keeps running until abort, then stops
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow()
    abort.abort()
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow()
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
})
